use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::{ImportResult, OAuthConfig, ResolutionContext, ServerProfile, TransportConfig};

pub const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    pub fn for_connection(profile: &ServerProfile, context: &ResolutionContext) -> Self {
        let mut secrets = BTreeSet::new();
        secrets.extend(
            context
                .inputs
                .values()
                .filter(|value| !value.is_empty())
                .cloned(),
        );
        collect_profile_secrets(profile, &mut secrets);
        Self::from_secrets(secrets)
    }

    pub fn for_import_result(result: &ImportResult) -> Self {
        let mut secrets = BTreeSet::new();
        for input in &result.inputs {
            if input.secret
                && let Some(default_value) = &input.default_value
                && !default_value.is_empty()
            {
                secrets.insert(default_value.clone());
            }
        }
        for profile in &result.profiles {
            collect_profile_secrets(profile, &mut secrets);
        }
        Self::from_secrets(secrets)
    }

    fn from_secrets(secrets: BTreeSet<String>) -> Self {
        let mut secrets = secrets.into_iter().collect::<Vec<_>>();
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Self { secrets }
    }

    pub fn register_sensitive_json(&mut self, value: &Value) {
        let mut secrets = self.secrets.iter().cloned().collect::<BTreeSet<_>>();
        collect_sensitive_json_values(value, &mut secrets);
        *self = Self::from_secrets(secrets);
    }

    pub fn redact_text(&self, value: &str) -> String {
        self.secrets.iter().fold(value.to_owned(), |text, secret| {
            text.replace(secret, REDACTED)
        })
    }

    pub fn redact_json(&self, value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| {
                        let value = if is_sensitive_name(key) {
                            Value::String(REDACTED.to_owned())
                        } else {
                            self.redact_json(value)
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            ),
            Value::Array(values) => {
                Value::Array(values.iter().map(|value| self.redact_json(value)).collect())
            }
            Value::String(value) => Value::String(self.redact_text(value)),
            value => value.clone(),
        }
    }

    pub fn redact_headers(&self, headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        headers
            .iter()
            .map(|(name, value)| {
                let value = if is_sensitive_name(name) {
                    REDACTED.to_owned()
                } else {
                    self.redact_text(value)
                };
                (name.clone(), value)
            })
            .collect()
    }

    pub fn redact_profile(&self, profile: &ServerProfile) -> ServerProfile {
        let mut profile = profile.clone();
        profile.transport = match &profile.transport {
            TransportConfig::Stdio {
                command,
                args,
                cwd,
                env,
                env_file,
            } => TransportConfig::Stdio {
                command: self.redact_text(command),
                args: args.iter().map(|value| self.redact_text(value)).collect(),
                cwd: cwd.as_deref().map(|value| self.redact_text(value)),
                env: env
                    .iter()
                    .map(|(name, value)| {
                        let value = if is_sensitive_name(name) {
                            Value::String(REDACTED.to_owned())
                        } else {
                            self.redact_json(value)
                        };
                        (name.clone(), value)
                    })
                    .collect(),
                env_file: env_file.as_deref().map(|value| self.redact_text(value)),
            },
            TransportConfig::Http {
                url,
                headers,
                oauth,
            } => TransportConfig::Http {
                url: self.redact_text(url),
                headers: self.redact_headers(headers),
                oauth: oauth.as_ref().map(|oauth| self.redact_oauth(oauth)),
            },
            TransportConfig::Sse {
                url,
                headers,
                oauth,
            } => TransportConfig::Sse {
                url: self.redact_text(url),
                headers: self.redact_headers(headers),
                oauth: oauth.as_ref().map(|oauth| self.redact_oauth(oauth)),
            },
            TransportConfig::Websocket { url, headers } => TransportConfig::Websocket {
                url: self.redact_text(url),
                headers: self.redact_headers(headers),
            },
        };
        profile
    }

    pub fn redact_import_result(&self, result: &ImportResult) -> ImportResult {
        let mut result = result.clone();
        result.profiles = result
            .profiles
            .iter()
            .map(|profile| self.redact_profile(profile))
            .collect();
        for input in &mut result.inputs {
            if input.secret && input.default_value.is_some() {
                input.default_value = Some(REDACTED.to_owned());
            }
        }
        result
    }

    fn redact_oauth(&self, oauth: &OAuthConfig) -> OAuthConfig {
        OAuthConfig {
            client_id: oauth
                .client_id
                .as_deref()
                .map(|value| self.redact_text(value)),
            callback_port: oauth.callback_port,
            scopes: oauth.scopes.as_deref().map(|value| self.redact_text(value)),
            auth_server_metadata_url: oauth
                .auth_server_metadata_url
                .as_deref()
                .map(|value| self.redact_text(value)),
            enterprise_managed: oauth.enterprise_managed,
        }
    }
}

fn collect_sensitive_json_values(value: &Value, secrets: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            for (name, value) in object {
                if is_sensitive_name(name) {
                    if let Value::String(value) = value
                        && !value.is_empty()
                    {
                        secrets.insert(value.clone());
                    }
                } else {
                    collect_sensitive_json_values(value, secrets);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_sensitive_json_values(value, secrets);
            }
        }
        _ => {}
    }
}

fn collect_profile_secrets(profile: &ServerProfile, secrets: &mut BTreeSet<String>) {
    match &profile.transport {
        TransportConfig::Http { url, headers, .. }
        | TransportConfig::Sse { url, headers, .. }
        | TransportConfig::Websocket { url, headers } => {
            collect_url_credentials(url, secrets);
            for (name, value) in headers {
                if is_sensitive_name(name) && !value.is_empty() {
                    secrets.insert(value.clone());
                }
            }
        }
        TransportConfig::Stdio { env, .. } => {
            for (name, value) in env {
                if is_sensitive_name(name)
                    && let Some(value) = value.as_str()
                    && !value.is_empty()
                {
                    secrets.insert(value.to_owned());
                }
            }
        }
    }
}

pub fn is_sensitive_name(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "authorization",
        "cookie",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "password",
        "passwd",
        "secret",
        "token",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn collect_url_credentials(url: &str, secrets: &mut BTreeSet<String>) {
    let Ok(url) = reqwest::Url::parse(url) else {
        return;
    };
    if !url.username().is_empty() {
        secrets.insert(url.username().to_owned());
    }
    if let Some(password) = url.password()
        && !password.is_empty()
    {
        secrets.insert(password.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ConfigSourceKind, FORMAT_VERSION, ProfileSource, ProtocolSelection, ServerProfile,
    };

    #[test]
    fn removes_connection_secrets_from_every_supported_shape() {
        let sentinel = "sentinel-secret-93e78";
        let profile = ServerProfile {
            format_version: FORMAT_VERSION,
            name: "redaction".to_owned(),
            transport: TransportConfig::Http {
                url: format!("https://user:{sentinel}@example.test/mcp"),
                headers: BTreeMap::from([
                    ("Authorization".to_owned(), format!("Bearer {sentinel}")),
                    ("X-Trace".to_owned(), format!("trace-{sentinel}")),
                ]),
                oauth: None,
            },
            protocol: ProtocolSelection::default(),
            source: ProfileSource {
                kind: ConfigSourceKind::Generic,
                path: None,
                scope: None,
            },
            timeout_ms: None,
            trusted: true,
        };
        let context = ResolutionContext {
            workspace_folder: None,
            environment: BTreeMap::new(),
            inputs: BTreeMap::from([("credential".to_owned(), sentinel.to_owned())]),
        };
        let redactor = Redactor::for_connection(&profile, &context);
        let data = serde_json::json!({
            "authorization": format!("Bearer {sentinel}"),
            "nested": [{ "message": format!("request failed for {sentinel}") }],
        });

        let redacted_text = redactor.redact_text(&format!(
            "request failed for https://user:{sentinel}@example.test/mcp"
        ));
        let redacted_json = redactor.redact_json(&data);
        let redacted_headers = redactor.redact_headers(match &profile.transport {
            TransportConfig::Http { headers, .. } => headers,
            _ => unreachable!(),
        });
        let output =
            serde_json::to_string(&(redacted_text, redacted_json, redacted_headers)).unwrap();

        assert!(!output.contains(sentinel));
        assert!(output.contains(REDACTED));
    }

    #[test]
    fn recognizes_common_sensitive_field_names() {
        for name in [
            "Authorization",
            "set-cookie",
            "X-API-Key",
            "access_token",
            "dbPassword",
        ] {
            assert!(is_sensitive_name(name), "expected {name} to be sensitive");
        }
        assert!(!is_sensitive_name("content-type"));
        assert!(!is_sensitive_name("client-id"));
    }

    #[test]
    fn redacts_imported_profiles_and_secret_input_defaults() {
        let sentinel = "import-secret-a143";
        let input = format!(
            r#"{{
                "mcpServers": {{
                    "remote": {{
                        "type": "http",
                        "url": "https://user:{sentinel}@example.test/mcp",
                        "headers": {{"Authorization": "Bearer {sentinel}"}}
                    }}
                }},
                "inputs": [{{
                    "type": "promptString",
                    "id": "token",
                    "description": "Token",
                    "password": true,
                    "default": "{sentinel}"
                }}]
            }}"#
        );
        let result = crate::import_config(&input, ConfigSourceKind::Auto, None).unwrap();
        let redacted = Redactor::for_import_result(&result).redact_import_result(&result);
        let output = serde_json::to_string(&redacted).unwrap();

        assert!(!output.contains(sentinel));
        assert!(output.contains(REDACTED));
    }

    #[test]
    fn learns_secrets_from_sensitive_request_fields() {
        let sentinel = "dynamic-secret-71ba";
        let mut redactor = Redactor::default();
        redactor.register_sensitive_json(&serde_json::json!({
            "nested": {"apiToken": sentinel}
        }));

        assert_eq!(redactor.redact_text(sentinel), REDACTED);
    }
}
