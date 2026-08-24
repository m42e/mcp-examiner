use std::collections::BTreeMap;

use serde_json::{Map, Value};
use thiserror::Error;

use crate::model::{
    ConfigInputDefinition, ConfigInputKind, ConfigInputOption, ConfigSourceKind, DiagnosticLevel,
    FORMAT_VERSION, ImportDiagnostic, ImportResult, OAuthConfig, ProfileSource, ProtocolSelection,
    ServerProfile, TransportConfig,
};

#[derive(Debug, Error)]
pub enum ConfigImportError {
    #[error("configuration is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("configuration root must be a JSON object")]
    InvalidRoot,
    #[error("configuration does not contain a supported server collection")]
    MissingServers,
}

pub fn import_config(
    input: &str,
    requested_source: ConfigSourceKind,
    path: Option<String>,
) -> Result<ImportResult, ConfigImportError> {
    let root: Value = serde_json::from_str(input)?;
    let root = root.as_object().ok_or(ConfigImportError::InvalidRoot)?;
    let source_kind = detect_source(root, requested_source);

    let mut profiles = Vec::new();
    let mut diagnostics = Vec::new();

    if let Some(servers) = root.get("servers").and_then(Value::as_object) {
        import_server_map(
            servers,
            source_kind.clone(),
            path.as_deref(),
            None,
            &mut profiles,
            &mut diagnostics,
        );
    } else if let Some(servers) = root.get("mcpServers").and_then(Value::as_object) {
        import_server_map(
            servers,
            source_kind.clone(),
            path.as_deref(),
            None,
            &mut profiles,
            &mut diagnostics,
        );
    } else if let Some(projects) = root.get("projects").and_then(Value::as_object) {
        for (project_path, project) in projects {
            if let Some(servers) = project.get("mcpServers").and_then(Value::as_object) {
                import_server_map(
                    servers,
                    ConfigSourceKind::Claude,
                    path.as_deref(),
                    Some(project_path),
                    &mut profiles,
                    &mut diagnostics,
                );
            }
        }
    } else {
        return Err(ConfigImportError::MissingServers);
    }

    let inputs = parse_top_level_inputs(root, &mut diagnostics);

    Ok(ImportResult {
        format_version: FORMAT_VERSION,
        source_kind,
        profiles,
        inputs,
        diagnostics,
    })
}

fn detect_source(
    root: &Map<String, Value>,
    requested_source: ConfigSourceKind,
) -> ConfigSourceKind {
    if requested_source != ConfigSourceKind::Auto {
        return requested_source;
    }

    if root.contains_key("servers") {
        ConfigSourceKind::VsCode
    } else if root.contains_key("projects") {
        ConfigSourceKind::Claude
    } else {
        ConfigSourceKind::Generic
    }
}

fn import_server_map(
    servers: &Map<String, Value>,
    source_kind: ConfigSourceKind,
    path: Option<&str>,
    scope: Option<&str>,
    profiles: &mut Vec<ServerProfile>,
    diagnostics: &mut Vec<ImportDiagnostic>,
) {
    for (name, value) in servers {
        let Some(server) = value.as_object() else {
            diagnostics.push(diagnostic(
                DiagnosticLevel::Error,
                Some(name),
                None,
                "Server entry must be an object",
            ));
            continue;
        };

        match parse_server(name, server) {
            Ok(transport) => {
                inspect_host_fields(name, server, diagnostics);
                profiles.push(ServerProfile {
                    format_version: FORMAT_VERSION,
                    name: name.clone(),
                    transport,
                    protocol: parse_protocol(server),
                    source: ProfileSource {
                        kind: source_kind.clone(),
                        path: path.map(str::to_owned),
                        scope: scope.map(str::to_owned),
                    },
                    timeout_ms: server.get("timeout").and_then(Value::as_u64),
                    trusted: false,
                });
            }
            Err(message) => diagnostics.push(diagnostic(
                DiagnosticLevel::Error,
                Some(name),
                Some("type"),
                message,
            )),
        }
    }
}

fn parse_server(name: &str, server: &Map<String, Value>) -> Result<TransportConfig, String> {
    let server_type = server
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if server.contains_key("command") {
                "stdio"
            } else {
                ""
            }
        });

    match server_type {
        "stdio" => {
            let command = required_string(server, "command", name)?;
            Ok(TransportConfig::Stdio {
                command,
                args: string_array(server.get("args"), "args", name)?,
                cwd: optional_string(server, "cwd", name)?,
                env: value_map(server.get("env"), "env", name)?,
                env_file: optional_string(server, "envFile", name)?,
            })
        }
        "http" | "streamable-http" => Ok(TransportConfig::Http {
            url: required_string(server, "url", name)?,
            headers: string_map(server.get("headers"), "headers", name)?,
            oauth: parse_oauth(server.get("oauth"), name)?,
        }),
        "sse" => Ok(TransportConfig::Sse {
            url: required_string(server, "url", name)?,
            headers: string_map(server.get("headers"), "headers", name)?,
            oauth: parse_oauth(server.get("oauth"), name)?,
        }),
        "ws" | "websocket" => Ok(TransportConfig::Websocket {
            url: required_string(server, "url", name)?,
            headers: string_map(server.get("headers"), "headers", name)?,
        }),
        "" if server.contains_key("url") => {
            Err("URL-based server is missing type; expected http, sse, or ws".to_owned())
        }
        other => Err(format!("Unsupported transport type '{other}'")),
    }
}

fn parse_protocol(server: &Map<String, Value>) -> ProtocolSelection {
    match server.get("protocolEra").and_then(Value::as_str) {
        Some("auto") => ProtocolSelection::Auto {
            legacy_version: Some("2025-11-25".to_owned()),
        },
        Some("modern") => ProtocolSelection::Modern,
        Some("legacy") => ProtocolSelection::default(),
        None => ProtocolSelection::Auto {
            legacy_version: Some("2025-11-25".to_owned()),
        },
        Some(version) => ProtocolSelection::Exact {
            version: version.to_owned(),
        },
    }
}

fn inspect_host_fields(
    name: &str,
    server: &Map<String, Value>,
    diagnostics: &mut Vec<ImportDiagnostic>,
) {
    for (field, message) in [
        (
            "sandboxEnabled",
            "VS Code sandbox settings are advisory and are not imported",
        ),
        (
            "dev",
            "VS Code development watchers and debugger settings are not imported",
        ),
        (
            "headersHelper",
            "Dynamic header helper requires explicit trust before it can run",
        ),
    ] {
        if server.contains_key(field) {
            diagnostics.push(diagnostic(
                DiagnosticLevel::Warning,
                Some(name),
                Some(field),
                message,
            ));
        }
    }
}

fn parse_top_level_inputs(
    root: &Map<String, Value>,
    diagnostics: &mut Vec<ImportDiagnostic>,
) -> Vec<ConfigInputDefinition> {
    let Some(inputs) = root.get("inputs").and_then(Value::as_array) else {
        return Vec::new();
    };

    inputs
        .iter()
        .filter_map(|input| {
            let input = input.as_object()?;
            let id = input.get("id")?.as_str()?.to_owned();
            let kind = match input.get("type").and_then(Value::as_str) {
                Some("promptString") => ConfigInputKind::Prompt,
                Some("pickString") => ConfigInputKind::Pick,
                Some("command") => {
                    diagnostics.push(diagnostic(
                        DiagnosticLevel::Warning,
                        None,
                        Some("inputs"),
                        "VS Code command inputs require a manual value outside VS Code",
                    ));
                    ConfigInputKind::Command
                }
                _ => return None,
            };
            let description = input
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            let options = input
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| match option {
                            Value::String(value) => Some(ConfigInputOption {
                                label: value.clone(),
                                value: value.clone(),
                            }),
                            Value::Object(option) => {
                                let value = option.get("value")?.as_str()?.to_owned();
                                Some(ConfigInputOption {
                                    label: option
                                        .get("label")
                                        .and_then(Value::as_str)
                                        .unwrap_or(&value)
                                        .to_owned(),
                                    value,
                                })
                            }
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(ConfigInputDefinition {
                id,
                kind,
                description,
                secret: input
                    .get("password")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_value: input
                    .get("default")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                options,
            })
        })
        .collect()
}

fn parse_oauth(value: Option<&Value>, name: &str) -> Result<Option<OAuthConfig>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| format!("Server '{name}' field 'oauth' must be an object"))?;

    let callback_port = match object.get("callbackPort") {
        Some(value) => {
            let raw = value.as_u64().ok_or_else(|| {
                format!("Server '{name}' field 'oauth.callbackPort' must be an integer")
            })?;
            Some(u16::try_from(raw).map_err(|_| {
                format!("Server '{name}' field 'oauth.callbackPort' is outside the valid range")
            })?)
        }
        None => None,
    };

    Ok(Some(OAuthConfig {
        client_id: optional_string(object, "clientId", name)?,
        callback_port,
        scopes: optional_string(object, "scopes", name)?,
        auth_server_metadata_url: optional_string(object, "authServerMetadataUrl", name)?,
        enterprise_managed: object
            .get("enterpriseManaged")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

fn required_string(object: &Map<String, Value>, field: &str, name: &str) -> Result<String, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Server '{name}' field '{field}' must be a string"))
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    name: &str,
) -> Result<Option<String>, String> {
    match object.get(field) {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(format!("Server '{name}' field '{field}' must be a string")),
    }
}

fn string_array(value: Option<&Value>, field: &str, name: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("Server '{name}' field '{field}' must be an array"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("Server '{name}' field '{field}' must contain only strings"))
        })
        .collect()
}

fn string_map(
    value: Option<&Value>,
    field: &str,
    name: &str,
) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let values = value
        .as_object()
        .ok_or_else(|| format!("Server '{name}' field '{field}' must be an object"))?;
    values
        .iter()
        .map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.clone(), value.to_owned()))
                .ok_or_else(|| format!("Server '{name}' field '{field}.{key}' must be a string"))
        })
        .collect()
}

fn value_map(
    value: Option<&Value>,
    field: &str,
    name: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    value
        .as_object()
        .cloned()
        .map(|values| values.into_iter().collect())
        .ok_or_else(|| format!("Server '{name}' field '{field}' must be an object"))
}

fn diagnostic(
    level: DiagnosticLevel,
    server: Option<&str>,
    field: Option<&str>,
    message: impl Into<String>,
) -> ImportDiagnostic {
    ImportDiagnostic {
        level,
        server: server.map(str::to_owned),
        field: field.map(str::to_owned),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_vscode_stdio_and_http_servers() {
        let input = r#"{
            "servers": {
                "local": {
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "example-server"],
                    "env": { "PORT": 3000, "TOKEN": "${input:token}" },
                    "sandboxEnabled": true
                },
                "remote": {
                    "type": "http",
                    "url": "https://example.test/mcp",
                    "headers": { "X-Tenant": "test" }
                }
            },
            "inputs": [{ "type": "command", "id": "token", "command": "secret.get" }]
        }"#;

        let result = import_config(input, ConfigSourceKind::Auto, None).unwrap();

        assert_eq!(result.source_kind, ConfigSourceKind::VsCode);
        assert_eq!(result.profiles.len(), 2);
        assert_eq!(result.inputs.len(), 1);
        assert_eq!(result.diagnostics.len(), 2);
        assert!(matches!(
            result.profiles[0].transport,
            TransportConfig::Stdio { .. }
        ));
        assert!(matches!(
            result.profiles[1].transport,
            TransportConfig::Http { .. }
        ));
    }

    #[test]
    fn imports_claude_aliases_and_project_scope() {
        let input = r#"{
            "projects": {
                "/workspace": {
                    "mcpServers": {
                        "api": {
                            "type": "streamable-http",
                            "url": "https://example.test/mcp",
                            "protocolEra": "modern"
                        },
                        "events": {
                            "type": "ws",
                            "url": "wss://example.test/mcp"
                        }
                    }
                }
            }
        }"#;

        let result = import_config(input, ConfigSourceKind::Auto, None).unwrap();

        assert_eq!(result.source_kind, ConfigSourceKind::Claude);
        assert_eq!(result.profiles.len(), 2);
        assert_eq!(
            result.profiles[0].source.scope.as_deref(),
            Some("/workspace")
        );
        assert_eq!(result.profiles[0].protocol, ProtocolSelection::Modern);
        assert!(matches!(
            result.profiles[1].transport,
            TransportConfig::Websocket { .. }
        ));
    }

    #[test]
    fn diagnoses_url_without_transport_type() {
        let input = r#"{
            "mcpServers": {
                "broken": { "url": "https://example.test/mcp" }
            }
        }"#;

        let result = import_config(input, ConfigSourceKind::Claude, None).unwrap();

        assert!(result.profiles.is_empty());
        assert_eq!(result.diagnostics[0].level, DiagnosticLevel::Error);
        assert!(result.diagnostics[0].message.contains("missing type"));
    }

    #[test]
    fn defaults_imported_servers_to_protocol_auto_negotiation() {
        let result = import_config(
            r#"{"mcpServers":{"remote":{"type":"http","url":"https://example.test/mcp"}}}"#,
            ConfigSourceKind::Auto,
            None,
        )
        .unwrap();

        assert_eq!(
            result.profiles[0].protocol,
            ProtocolSelection::Auto {
                legacy_version: Some("2025-11-25".to_owned())
            }
        );
    }
}
