use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use keyring::Entry;
use mcp_examiner_core::{ResolutionContext, ServerProfile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "io.mcpexaminer.desktop.secrets";
const INDEX_FILENAME: &str = "secrets.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub id: String,
    pub label: String,
    pub updated_at_unix_ms: u64,
    pub available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSecretRequest {
    pub id: String,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretMetadata {
    id: String,
    label: String,
    updated_at_unix_ms: u64,
}

pub fn list(app: &AppHandle) -> Result<Vec<SecretSummary>, String> {
    let records = read_index(app)?;
    let mut summaries = records
        .into_iter()
        .map(|record| SecretSummary {
            available: read_keychain_secret(&record.id).is_ok(),
            id: record.id,
            label: record.label,
            updated_at_unix_ms: record.updated_at_unix_ms,
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| left.label.to_lowercase().cmp(&right.label.to_lowercase()));
    Ok(summaries)
}

pub fn set(app: &AppHandle, request: SetSecretRequest) -> Result<SecretSummary, String> {
    let id = validate_id(&request.id)?;
    let label = validate_label(&request.label, &id)?;
    if request.value.is_empty() {
        return Err("Secret value cannot be empty.".to_owned());
    }

    keychain_entry(&id)?
        .set_password(&request.value)
        .map_err(|error| format!("Could not store secret '{id}' in the OS keychain: {error}"))?;

    let mut records = read_index(app)?;
    let updated_at_unix_ms = now_unix_ms();
    if let Some(record) = records.iter_mut().find(|record| record.id == id) {
        record.label = label.clone();
        record.updated_at_unix_ms = updated_at_unix_ms;
    } else {
        records.push(SecretMetadata {
            id: id.clone(),
            label: label.clone(),
            updated_at_unix_ms,
        });
    }
    write_index(app, &records)?;

    Ok(SecretSummary {
        id,
        label,
        updated_at_unix_ms,
        available: true,
    })
}

pub fn get(id: &str) -> Result<String, String> {
    let id = validate_id(id)?;
    read_keychain_secret(&id)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = validate_id(id)?;
    let _ = keychain_entry(&id)?.delete_credential();
    let mut records = read_index(app)?;
    records.retain(|record| record.id != id);
    write_index(app, &records)
}

pub fn hydrate_context(profile: &ServerProfile, context: &mut ResolutionContext) {
    for id in referenced_ids(profile, "secret:") {
        if !context.secrets.contains_key(&id)
            && let Ok(value) = read_keychain_secret(&id)
        {
            context.secrets.insert(id, value);
        }
    }

    for id in referenced_ids(profile, "input:") {
        let has_value = context
            .inputs
            .get(&id)
            .is_some_and(|value| !value.is_empty());
        if !has_value && let Ok(value) = read_keychain_secret(&id) {
            context.inputs.insert(id, value);
        }
    }
}

fn keychain_entry(id: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, id).map_err(|error| error.to_string())
}

fn read_keychain_secret(id: &str) -> Result<String, String> {
    keychain_entry(id)?
        .get_password()
        .map_err(|error| format!("Could not read secret '{id}' from the OS keychain: {error}"))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(INDEX_FILENAME))
}

fn read_index(app: &AppHandle) -> Result<Vec<SecretMetadata>, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| format!("Invalid secrets index: {error}"))
}

fn write_index(app: &AppHandle, records: &[SecretMetadata]) -> Result<(), String> {
    let path = index_path(app)?;
    let temporary_path = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(records).map_err(|error| error.to_string())?;
    fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    fs::rename(temporary_path, path).map_err(|error| error.to_string())
}

fn validate_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty()
        || id.len() > 128
        || id.chars().any(char::is_control)
        || id.contains("${")
        || id.contains('}')
    {
        return Err("Secret IDs must be 1-128 characters without control characters or '${' / '}' delimiters.".to_owned());
    }
    Ok(id.to_owned())
}

fn validate_label(label: &str, id: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Ok(id.to_owned());
    }
    if label.len() > 200 {
        return Err("Secret labels must be 200 characters or fewer.".to_owned());
    }
    Ok(label.to_owned())
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn referenced_ids(profile: &ServerProfile, prefix: &str) -> BTreeSet<String> {
    let Ok(value) = serde_json::to_value(profile) else {
        return BTreeSet::new();
    };
    let mut ids = BTreeSet::new();
    collect_references(&value, prefix, &mut ids);
    ids
}

fn collect_references(value: &Value, prefix: &str, ids: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => {
            for (start, _) in text.match_indices("${") {
                let expression = &text[start + 2..];
                let Some(end) = expression.find('}') else {
                    continue;
                };
                if let Some(id) = expression[..end].strip_prefix(prefix)
                    && !id.is_empty()
                {
                    ids.insert(id.to_owned());
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_references(value, prefix, ids);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_references(value, prefix, ids);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_references_from_nested_profile_values() {
        let value = serde_json::json!({
            "headers": {
                "Authorization": "Bearer ${secret:api-token}",
                "X-Input": "${input:workspace token}"
            },
            "args": ["${secret:api-token}"]
        });
        let mut ids = BTreeSet::new();

        collect_references(&value, "secret:", &mut ids);

        assert_eq!(ids, BTreeSet::from(["api-token".to_owned()]));
    }

    #[test]
    fn accepts_vscode_input_ids_with_spaces() {
        assert_eq!(validate_id("workspace token").unwrap(), "workspace token");
        assert!(validate_id("bad${id}").is_err());
    }
}
