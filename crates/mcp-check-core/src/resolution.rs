use std::{collections::BTreeMap, env, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{OAuthConfig, ServerProfile, TransportConfig};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionContext {
    pub workspace_folder: Option<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

impl ResolutionContext {
    pub fn from_process() -> Self {
        Self {
            workspace_folder: env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            environment: env::vars().collect(),
            inputs: BTreeMap::new(),
            secrets: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResolutionError {
    #[error("workspace folder is required by this server configuration")]
    MissingWorkspaceFolder,
    #[error("missing configuration input '{0}'")]
    MissingInput(String),
    #[error("missing managed secret '{0}'")]
    MissingSecret(String),
    #[error("missing environment variable '{0}'")]
    MissingEnvironment(String),
    #[error("unterminated variable expression in configuration field")]
    UnterminatedExpression,
    #[error("failed to read environment file '{0}'")]
    EnvironmentFile(String),
}

pub fn resolve_profile(
    profile: &ServerProfile,
    context: &ResolutionContext,
) -> Result<ServerProfile, ResolutionError> {
    let mut resolved = profile.clone();
    resolved.transport = match &profile.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
            env_file,
        } => {
            let resolved_cwd = cwd
                .as_deref()
                .map(|cwd| resolve_string(cwd, context))
                .transpose()?;
            let resolved_env_file = env_file
                .as_deref()
                .map(|path| resolve_string(path, context))
                .transpose()?
                .map(|path| resolve_env_file_path(&path, resolved_cwd.as_deref()));
            let mut environment = context.environment.clone();
            if let Some(path) = &resolved_env_file {
                let variables = dotenvy::from_path_iter(path)
                    .map_err(|_| ResolutionError::EnvironmentFile(path.clone()))?;
                for variable in variables {
                    let (key, value) =
                        variable.map_err(|_| ResolutionError::EnvironmentFile(path.clone()))?;
                    environment.insert(key, value);
                }
            }
            let nested_context = ResolutionContext {
                workspace_folder: context.workspace_folder.clone(),
                environment: environment.clone(),
                inputs: context.inputs.clone(),
                secrets: context.secrets.clone(),
            };
            let explicit_env = env
                .iter()
                .map(|(key, value)| {
                    let value = match value {
                        Value::String(value) => {
                            Value::String(resolve_string(value, &nested_context)?)
                        }
                        value => value.clone(),
                    };
                    Ok((key.clone(), value))
                })
                .collect::<Result<BTreeMap<_, _>, ResolutionError>>()?;
            let mut resolved_env = environment
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect::<BTreeMap<_, _>>();
            resolved_env.extend(explicit_env);
            TransportConfig::Stdio {
                command: resolve_string(command, &nested_context)?,
                args: args
                    .iter()
                    .map(|argument| resolve_string(argument, &nested_context))
                    .collect::<Result<_, _>>()?,
                cwd: resolved_cwd,
                env: resolved_env,
                env_file: None,
            }
        }
        TransportConfig::Http {
            url,
            headers,
            oauth,
        } => TransportConfig::Http {
            url: resolve_string(url, context)?,
            headers: resolve_map(headers, context)?,
            oauth: resolve_oauth(oauth.as_ref(), context)?,
        },
        TransportConfig::Sse {
            url,
            headers,
            oauth,
        } => TransportConfig::Sse {
            url: resolve_string(url, context)?,
            headers: resolve_map(headers, context)?,
            oauth: resolve_oauth(oauth.as_ref(), context)?,
        },        TransportConfig::Auto {
            url,
            headers,
            oauth,
         } => TransportConfig::Auto {
            url: resolve_string(url, context)?,
            headers: resolve_map(headers, context)?,
            oauth: resolve_oauth(oauth.as_ref(), context)?,
         },        TransportConfig::Websocket { url, headers } => TransportConfig::Websocket {
            url: resolve_string(url, context)?,
            headers: resolve_map(headers, context)?,
        },
    };
    Ok(resolved)
}

fn resolve_env_file_path(path: &str, cwd: Option<&str>) -> String {
    let path = Path::new(path);
    if path.is_relative()
        && let Some(cwd) = cwd
    {
        return Path::new(cwd).join(path).to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
}

fn resolve_oauth(
    oauth: Option<&OAuthConfig>,
    context: &ResolutionContext,
) -> Result<Option<OAuthConfig>, ResolutionError> {
    oauth
        .map(|oauth| {
            Ok(OAuthConfig {
                client_id: oauth
                    .client_id
                    .as_deref()
                    .map(|value| resolve_string(value, context))
                    .transpose()?,
                callback_port: oauth.callback_port,
                scopes: oauth
                    .scopes
                    .as_deref()
                    .map(|value| resolve_string(value, context))
                    .transpose()?,
                auth_server_metadata_url: oauth
                    .auth_server_metadata_url
                    .as_deref()
                    .map(|value| resolve_string(value, context))
                    .transpose()?,
                enterprise_managed: oauth.enterprise_managed,
            })
        })
        .transpose()
}

fn resolve_map(
    values: &BTreeMap<String, String>,
    context: &ResolutionContext,
) -> Result<BTreeMap<String, String>, ResolutionError> {
    values
        .iter()
        .map(|(key, value)| Ok((key.clone(), resolve_string(value, context)?)))
        .collect()
}

fn resolve_string(input: &str, context: &ResolutionContext) -> Result<String, ResolutionError> {
    let mut output = String::with_capacity(input.len());
    let mut remainder = input;
    while let Some(start) = remainder.find("${") {
        output.push_str(&remainder[..start]);
        let expression = &remainder[start + 2..];
        let end = expression
            .find('}')
            .ok_or(ResolutionError::UnterminatedExpression)?;
        output.push_str(&resolve_expression(&expression[..end], context)?);
        remainder = &expression[end + 1..];
    }
    output.push_str(remainder);
    Ok(output)
}

fn resolve_expression(
    expression: &str,
    context: &ResolutionContext,
) -> Result<String, ResolutionError> {
    if expression == "workspaceFolder" {
        return context
            .workspace_folder
            .clone()
            .ok_or(ResolutionError::MissingWorkspaceFolder);
    }
    if let Some(id) = expression.strip_prefix("input:") {
        return context
            .inputs
            .get(id)
            .cloned()
            .ok_or_else(|| ResolutionError::MissingInput(id.to_owned()));
    }
    if let Some(id) = expression.strip_prefix("secret:") {
        return context
            .secrets
            .get(id)
            .cloned()
            .ok_or_else(|| ResolutionError::MissingSecret(id.to_owned()));
    }
    if let Some(name) = expression.strip_prefix("env:") {
        return environment_value(name, None, context);
    }
    if let Some((name, default)) = expression.split_once(":-") {
        return environment_value(name, Some(default), context);
    }
    environment_value(expression, None, context)
}

fn environment_value(
    name: &str,
    default: Option<&str>,
    context: &ResolutionContext,
) -> Result<String, ResolutionError> {
    context
        .environment
        .get(name)
        .cloned()
        .or_else(|| default.map(str::to_owned))
        .ok_or_else(|| ResolutionError::MissingEnvironment(name.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConfigSourceKind, FORMAT_VERSION, ProfileSource, ProtocolSelection};

    fn profile() -> ServerProfile {
        ServerProfile {
            format_version: FORMAT_VERSION,
            name: "resolved".to_owned(),
            transport: TransportConfig::Stdio {
                command: "${env:RUNTIME}".to_owned(),
                args: vec!["${workspaceFolder}/server.js".to_owned()],
                cwd: Some("${workspaceFolder}".to_owned()),
                env: BTreeMap::from([
                    (
                        "TOKEN".to_owned(),
                        Value::String("${input:token}".to_owned()),
                    ),
                    (
                        "REGION".to_owned(),
                        Value::String("${REGION:-local}".to_owned()),
                    ),
                ]),
                env_file: None,
            },
            protocol: ProtocolSelection::default(),
            source: ProfileSource {
                kind: ConfigSourceKind::Generic,
                path: None,
                scope: None,
            },
            timeout_ms: None,
            trusted: false,
        }
    }

    #[test]
    fn resolves_workspace_environment_inputs_and_defaults() {
        let context = ResolutionContext {
            workspace_folder: Some("/project".to_owned()),
            environment: BTreeMap::from([("RUNTIME".to_owned(), "node".to_owned())]),
            inputs: BTreeMap::from([("token".to_owned(), "secret-value".to_owned())]),
            secrets: BTreeMap::new(),
        };

        let resolved = resolve_profile(&profile(), &context).unwrap();
        let TransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
            env_file,
        } = resolved.transport
        else {
            panic!("expected stdio")
        };
        assert_eq!(command, "node");
        assert_eq!(args, ["/project/server.js"]);
        assert_eq!(cwd.as_deref(), Some("/project"));
        assert_eq!(env["TOKEN"], "secret-value");
        assert_eq!(env["REGION"], "local");
        assert!(env_file.is_none());
    }

    #[test]
    fn resolves_managed_secret_references() {
        let mut profile = profile();
        let TransportConfig::Stdio { args, .. } = &mut profile.transport else {
            panic!("expected stdio")
        };
        args.push("${secret:api-token}".to_owned());

        let resolved = resolve_profile(
            &profile,
            &ResolutionContext {
                workspace_folder: Some("/project".to_owned()),
                environment: BTreeMap::from([("RUNTIME".to_owned(), "node".to_owned())]),
                inputs: BTreeMap::from([("token".to_owned(), "secret-value".to_owned())]),
                secrets: BTreeMap::from([("api-token".to_owned(), "managed-secret".to_owned())]),
            },
        )
        .unwrap();

        let TransportConfig::Stdio { args, .. } = resolved.transport else {
            panic!("expected stdio")
        };
        assert_eq!(args.last().map(String::as_str), Some("managed-secret"));
    }

    #[test]
    fn reports_missing_managed_secret_without_exposing_a_value() {
        let mut profile = profile();
        let TransportConfig::Stdio { args, .. } = &mut profile.transport else {
            panic!("expected stdio")
        };
        args.push("${secret:missing-token}".to_owned());

        let error = resolve_profile(
            &profile,
            &ResolutionContext {
                workspace_folder: Some("/project".to_owned()),
                environment: BTreeMap::from([("RUNTIME".to_owned(), "node".to_owned())]),
                inputs: BTreeMap::from([("token".to_owned(), "secret-value".to_owned())]),
                secrets: BTreeMap::new(),
            },
        )
        .unwrap_err();

        assert_eq!(
            error,
            ResolutionError::MissingSecret("missing-token".to_owned())
        );
        assert_eq!(error.to_string(), "missing managed secret 'missing-token'");
    }

    #[test]
    fn reports_missing_input_without_exposing_other_values() {
        let error = resolve_profile(
            &profile(),
            &ResolutionContext {
                workspace_folder: Some("/project".to_owned()),
                environment: BTreeMap::from([("RUNTIME".to_owned(), "node".to_owned())]),
                inputs: BTreeMap::new(),
                secrets: BTreeMap::new(),
            },
        )
        .unwrap_err();

        assert_eq!(error, ResolutionError::MissingInput("token".to_owned()));
        assert_eq!(error.to_string(), "missing configuration input 'token'");
    }

    #[test]
    fn loads_relative_env_file_before_explicit_environment() {
        let directory =
            env::temp_dir().join(format!("mcp-check-resolution-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("server.env"),
            "RUNTIME=bun\nREGION=from-file\nFILE_ONLY=available\n",
        )
        .unwrap();
        let mut profile = profile();
        let TransportConfig::Stdio { env_file, env, .. } = &mut profile.transport else {
            panic!("expected stdio")
        };
        *env_file = Some("server.env".to_owned());
        env.insert(
            "REGION".to_owned(),
            Value::String("explicit-profile".to_owned()),
        );
        env.insert(
            "COPIED".to_owned(),
            Value::String("${FILE_ONLY}".to_owned()),
        );
        let context = ResolutionContext {
            workspace_folder: Some(directory.to_string_lossy().into_owned()),
            environment: BTreeMap::new(),
            inputs: BTreeMap::from([("token".to_owned(), "secret-value".to_owned())]),
            secrets: BTreeMap::new(),
        };

        let resolved = resolve_profile(&profile, &context).unwrap();
        let TransportConfig::Stdio {
            command,
            env,
            env_file,
            ..
        } = resolved.transport
        else {
            panic!("expected stdio")
        };
        assert_eq!(command, "bun");
        assert_eq!(env["REGION"], "explicit-profile");
        assert_eq!(env["FILE_ONLY"], "available");
        assert_eq!(env["COPIED"], "available");
        assert!(env_file.is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
