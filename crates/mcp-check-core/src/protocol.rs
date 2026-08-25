use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    time::{Duration, Instant},
};

use http::{HeaderName, HeaderValue};
use rmcp::{
    model::{
        CallToolRequestParams, ClientCapabilities, ClientInfo, GetPromptRequestParams,
        Implementation, JsonObject, ProtocolVersion, ReadResourceRequestParams, Tool,
    },
    service::{
        ClientCacheConfig, ClientInitializeError, ClientLifecycleMode, ClientServiceExt,
        RoleClient, RunningService,
    },
    transport::{
        StreamableHttpClientTransport, TokioChildProcess,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{process::Command, sync::Mutex, time::timeout};

use crate::{
    HttpObservation, ObservableHttpClient, PUBLISHED_PROTOCOL_VERSIONS, ProtocolSelection,
    Redactor, ResolutionContext, ResolutionError, ServerProfile, TransportConfig,
    TransportRecorder, resolve_profile,
};

type LiveSession = RunningService<RoleClient, ClientInfo>;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("server profile '{0}' has not been trusted")]
    UntrustedProfile(String),
    #[error("transport '{0}' is not available in this implementation slice")]
    UnsupportedTransport(String),
    #[error("unsupported protocol revision '{0}'")]
    UnsupportedVersion(String),
    #[error("environment variable '{0}' must be a string, number, boolean, or null")]
    InvalidEnvironmentValue(String),
    #[error("invalid HTTP header name '{0}'")]
    InvalidHeaderName(String),
    #[error("invalid value for HTTP header '{0}'")]
    InvalidHeaderValue(String),
    #[error("unable to start MCP server: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("MCP connection failed: {0}")]
    Connect(String),
    #[error("automatic discovery failed ({discover}); legacy fallback failed ({legacy})")]
    AutoFallback { discover: String, legacy: String },
    #[error("MCP request timed out after {0} ms")]
    Timeout(u64),
    #[error("server did not provide negotiated peer information")]
    MissingPeerInfo,
    #[error("server negotiated protocol {actual}, but {expected} was requested")]
    VersionMismatch { expected: String, actual: String },
    #[error("server '{0}' is not connected")]
    NotConnected(String),
    #[error("tool arguments must be a JSON object")]
    InvalidToolArguments,
    #[error("prompt arguments must be a JSON object")]
    InvalidPromptArguments,
    #[error("failed to serialize MCP data: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("failed to stop MCP server: {0}")]
    Shutdown(String),
    #[error(transparent)]
    Resolution(#[from] ResolutionError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSummary {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub annotations: Option<Value>,
    pub metadata: Option<Value>,
}

impl TryFrom<Tool> for ToolSummary {
    type Error = serde_json::Error;

    fn try_from(tool: Tool) -> Result<Self, Self::Error> {
        Ok(Self {
            name: tool.name.into_owned(),
            title: tool.title,
            description: tool.description.map(|description| description.into_owned()),
            input_schema: Value::Object(tool.input_schema.as_ref().clone()),
            output_schema: tool
                .output_schema
                .map(|schema| Value::Object(schema.as_ref().clone())),
            annotations: tool.annotations.map(serde_json::to_value).transpose()?,
            metadata: tool.meta.map(serde_json::to_value).transpose()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub server_name: String,
    pub protocol_version: String,
    pub server_info: Option<Value>,
    pub capabilities: Value,
    pub instructions: Option<String>,
    pub tools: Vec<ToolSummary>,
    pub resources: Vec<Value>,
    pub resource_templates: Vec<Value>,
    pub prompts: Vec<Value>,
    pub discovery_errors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtocolEventDirection {
    ClientToServer,
    ServerToClient,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEvent {
    pub sequence: u64,
    pub elapsed_ms: u64,
    pub direction: ProtocolEventDirection,
    pub method: String,
    pub payload: Value,
}

struct ManagedSession {
    service: LiveSession,
    redactor: Redactor,
    transport_recorder: Option<TransportRecorder>,
    started: Instant,
    next_sequence: u64,
    events: Vec<ProtocolEvent>,
}

impl ManagedSession {
    fn new(
        service: LiveSession,
        redactor: Redactor,
        transport_recorder: Option<TransportRecorder>,
    ) -> Self {
        Self {
            service,
            redactor,
            transport_recorder,
            started: Instant::now(),
            next_sequence: 1,
            events: Vec::new(),
        }
    }

    fn record(&mut self, direction: ProtocolEventDirection, method: &str, payload: Value) {
        self.events.push(ProtocolEvent {
            sequence: self.next_sequence,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            direction,
            method: method.to_owned(),
            payload: self.redactor.redact_json(&payload),
        });
        self.next_sequence += 1;
    }
}

#[derive(Default)]
struct SessionState {
    sessions: HashMap<String, ManagedSession>,
    histories: HashMap<String, Vec<ProtocolEvent>>,
    transport_histories: HashMap<String, Vec<HttpObservation>>,
}

#[derive(Default)]
pub struct SessionManager {
    state: Mutex<SessionState>,
}

impl SessionManager {
    pub async fn connect(
        &self,
        profile: &ServerProfile,
    ) -> Result<ConnectionSnapshot, ProtocolError> {
        self.connect_with_context(profile, &ResolutionContext::from_process())
            .await
    }

    pub async fn connect_with_context(
        &self,
        profile: &ServerProfile,
        context: &ResolutionContext,
    ) -> Result<ConnectionSnapshot, ProtocolError> {
        let redactor = Redactor::for_connection(profile, context);
        let profile = resolve_profile(profile, context)?;
        if !profile.trusted {
            return Err(ProtocolError::UntrustedProfile(profile.name.clone()));
        }

        let (client_info, lifecycle, expected_version) = protocol_setup(&profile.protocol)?;
        let (session, transport_recorder) = match &profile.transport {
            TransportConfig::Stdio {
                command,
                args,
                cwd,
                env,
                env_file,
            } => {
                let mut process = Command::new(command);
                process.args(args);
                process.kill_on_drop(true);
                if let Some(cwd) = cwd {
                    process.current_dir(cwd);
                }
                debug_assert!(env_file.is_none());
                for (key, value) in env {
                    match environment_value(key, value)? {
                        Some(value) => {
                            process.env(key, value);
                        }
                        None => {
                            process.env_remove(key);
                        }
                    }
                }

                let transport = TokioChildProcess::new(process)?;
                let session = await_connection(
                    client_info.serve_with_lifecycle(transport, lifecycle),
                    profile.timeout_ms,
                )
                .await?;
                (session, None)
            }
            TransportConfig::Http { url, headers, .. }
              | TransportConfig::Auto { url, headers, .. } => {
                let recorder = TransportRecorder::new(redactor.clone());
                let config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                    .custom_headers(parse_headers(headers)?);
                let transport = StreamableHttpClientTransport::with_client(
                    ObservableHttpClient::new(recorder.clone()),
                    config,
                );
                let connection = await_connection(
                    client_info.serve_with_lifecycle(transport, lifecycle),
                    profile.timeout_ms,
                )
                .await;
                let session = match connection {
                    Ok(session) => session,
                    Err(discover_error)
                        if matches!(profile.protocol, ProtocolSelection::Auto { .. }) =>
                    {
                        let ProtocolSelection::Auto { legacy_version } = &profile.protocol else {
                            unreachable!()
                        };
                        let fallback_selection = ProtocolSelection::Legacy {
                            version: legacy_version.clone(),
                        };
                        let (client_info, lifecycle, _) = protocol_setup(&fallback_selection)?;
                        let config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                            .custom_headers(parse_headers(headers)?);
                        let transport = StreamableHttpClientTransport::with_client(
                            ObservableHttpClient::new(recorder.clone()),
                            config,
                        );
                        await_connection(
                            client_info.serve_with_lifecycle(transport, lifecycle),
                            profile.timeout_ms,
                        )
                        .await
                        .map_err(|legacy_error| {
                            ProtocolError::AutoFallback {
                                discover: discover_error.to_string(),
                                legacy: legacy_error.to_string(),
                            }
                        })?
                    }
                    Err(error) => return Err(error),
                };
                (session, Some(recorder))
            }
            other => {
                return Err(ProtocolError::UnsupportedTransport(
                    transport_name(other).to_owned(),
                ));
            }
        };

        session
            .set_response_cache_config(ClientCacheConfig::disabled())
            .await;

        let peer_info = session.peer_info().ok_or(ProtocolError::MissingPeerInfo)?;

        if let Some(expected) = expected_version {
            if peer_info.protocol_version != expected {
                let actual = peer_info.protocol_version.to_string();
                let expected = expected.to_string();
                session
                    .cancel()
                    .await
                    .map_err(|error| ProtocolError::Shutdown(error.to_string()))?;
                return Err(ProtocolError::VersionMismatch { expected, actual });
            }
        }

        let mut discovery_errors = BTreeMap::new();
        let tools = if peer_info.capabilities.tools.is_some() {
            match session.list_all_tools().await {
                Ok(tools) => match tools
                    .into_iter()
                    .map(ToolSummary::try_from)
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(tools) => tools,
                    Err(error) => {
                        discovery_errors.insert("tools".to_owned(), error.to_string());
                        Vec::new()
                    }
                },
                Err(error) => {
                    discovery_errors.insert("tools".to_owned(), error.to_string());
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let resources = if peer_info.capabilities.resources.is_some() {
            match session.list_all_resources().await {
                Ok(resources) => serialize_items(resources)?,
                Err(error) => {
                    discovery_errors.insert("resources".to_owned(), error.to_string());
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let resource_templates = if peer_info.capabilities.resources.is_some() {
            match session.list_all_resource_templates().await {
                Ok(templates) => serialize_items(templates)?,
                Err(error) => {
                    discovery_errors.insert("resourceTemplates".to_owned(), error.to_string());
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let prompts = if peer_info.capabilities.prompts.is_some() {
            match session.list_all_prompts().await {
                Ok(prompts) => serialize_items(prompts)?,
                Err(error) => {
                    discovery_errors.insert("prompts".to_owned(), error.to_string());
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let snapshot = ConnectionSnapshot {
            server_name: profile.name.clone(),
            protocol_version: peer_info.protocol_version.to_string(),
            server_info: peer_info
                .server_info
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?,
            capabilities: serde_json::to_value(&peer_info.capabilities)?,
            instructions: peer_info.instructions.clone(),
            tools,
            resources,
            resource_templates,
            prompts,
            discovery_errors,
        };

        let mut managed = ManagedSession::new(session, redactor, transport_recorder);
        managed.record(
            ProtocolEventDirection::Internal,
            "session/connect",
            serde_json::json!({
                "protocolVersion": snapshot.protocol_version,
                "tools": snapshot.tools.len(),
                "resources": snapshot.resources.len(),
                "resourceTemplates": snapshot.resource_templates.len(),
                "prompts": snapshot.prompts.len(),
                "discoveryErrors": snapshot.discovery_errors,
            }),
        );
        let previous = {
            let mut state = self.state.lock().await;
            state.histories.remove(&profile.name);
            state.transport_histories.remove(&profile.name);
            state.sessions.insert(profile.name.clone(), managed)
        };
        if let Some(previous) = previous {
            let events = previous.events.clone();
            previous
                .service
                .cancel()
                .await
                .map_err(|error| ProtocolError::Shutdown(error.to_string()))?;
            self.state
                .lock()
                .await
                .histories
                .insert(profile.name.clone(), events);
        }

        Ok(snapshot)
    }

    pub async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<Value, ProtocolError> {
        let arguments = match arguments {
            Value::Object(arguments) => arguments,
            Value::Null => JsonObject::new(),
            _ => return Err(ProtocolError::InvalidToolArguments),
        };
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(server_name)
            .ok_or_else(|| ProtocolError::NotConnected(server_name.to_owned()))?;
        session
            .redactor
            .register_sensitive_json(&Value::Object(arguments.clone()));
        session.record(
            ProtocolEventDirection::ClientToServer,
            "tools/call",
            serde_json::json!({"name": tool_name, "arguments": arguments}),
        );
        let result = session
            .service
            .call_tool(CallToolRequestParams::new(tool_name.to_owned()).with_arguments(arguments))
            .await
            .map_err(|error| ProtocolError::Connect(error.to_string()));
        record_result(session, "tools/call", result)
    }

    pub async fn disconnect(&self, server_name: &str) -> Result<(), ProtocolError> {
        let mut session = self
            .state
            .lock()
            .await
            .sessions
            .remove(server_name)
            .ok_or_else(|| ProtocolError::NotConnected(server_name.to_owned()))?;
        session.record(
            ProtocolEventDirection::Internal,
            "session/disconnect",
            Value::Null,
        );
        let shutdown = session
            .service
            .cancel()
            .await
            .map_err(|error| ProtocolError::Shutdown(error.to_string()));
        let transport_events = session
            .transport_recorder
            .as_ref()
            .map(TransportRecorder::observations)
            .unwrap_or_default();
        let mut state = self.state.lock().await;
        state
            .histories
            .insert(server_name.to_owned(), session.events);
        state
            .transport_histories
            .insert(server_name.to_owned(), transport_events);
        shutdown.map(|_| ())
    }

    pub async fn read_resource(
        &self,
        server_name: &str,
        uri: &str,
    ) -> Result<Value, ProtocolError> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(server_name)
            .ok_or_else(|| ProtocolError::NotConnected(server_name.to_owned()))?;
        session.record(
            ProtocolEventDirection::ClientToServer,
            "resources/read",
            serde_json::json!({"uri": uri}),
        );
        let result = session
            .service
            .read_resource(ReadResourceRequestParams::new(uri))
            .await
            .map_err(|error| ProtocolError::Connect(error.to_string()));
        record_result(session, "resources/read", result)
    }

    pub async fn get_prompt(
        &self,
        server_name: &str,
        prompt_name: &str,
        arguments: Value,
    ) -> Result<Value, ProtocolError> {
        let arguments = match arguments {
            Value::Object(arguments) => arguments,
            Value::Null => JsonObject::new(),
            _ => return Err(ProtocolError::InvalidPromptArguments),
        };
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(server_name)
            .ok_or_else(|| ProtocolError::NotConnected(server_name.to_owned()))?;
        session
            .redactor
            .register_sensitive_json(&Value::Object(arguments.clone()));
        session.record(
            ProtocolEventDirection::ClientToServer,
            "prompts/get",
            serde_json::json!({"name": prompt_name, "arguments": arguments}),
        );
        let result = session
            .service
            .get_prompt(
                GetPromptRequestParams::new(prompt_name.to_owned()).with_arguments(arguments),
            )
            .await
            .map_err(|error| ProtocolError::Connect(error.to_string()));
        record_result(session, "prompts/get", result)
    }

    pub async fn events(&self, server_name: &str) -> Vec<ProtocolEvent> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(server_name)
            .map(|session| session.events.clone())
            .or_else(|| state.histories.get(server_name).cloned())
            .unwrap_or_default()
    }

    pub async fn http_observations(&self, server_name: &str) -> Vec<HttpObservation> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(server_name)
            .and_then(|session| session.transport_recorder.as_ref())
            .map(TransportRecorder::observations)
            .or_else(|| state.transport_histories.get(server_name).cloned())
            .unwrap_or_default()
    }
}

fn record_result<T: Serialize>(
    session: &mut ManagedSession,
    method: &str,
    result: Result<T, ProtocolError>,
) -> Result<Value, ProtocolError> {
    match result {
        Ok(result) => {
            let result = serde_json::to_value(result)?;
            let result = session.redactor.redact_json(&result);
            session.record(
                ProtocolEventDirection::ServerToClient,
                method,
                result.clone(),
            );
            Ok(result)
        }
        Err(error) => {
            session.record(
                ProtocolEventDirection::ServerToClient,
                method,
                serde_json::json!({"error": error.to_string()}),
            );
            Err(error)
        }
    }
}

fn serialize_items<T: Serialize>(items: Vec<T>) -> Result<Vec<Value>, serde_json::Error> {
    items.into_iter().map(serde_json::to_value).collect()
}

fn protocol_setup(
    selection: &ProtocolSelection,
) -> Result<(ClientInfo, ClientLifecycleMode, Option<ProtocolVersion>), ProtocolError> {
    let identity =
        Implementation::new("mcp-check", env!("CARGO_PKG_VERSION")).with_title("MCP Check");
    let capabilities = ClientCapabilities::default();

    match selection {
        ProtocolSelection::Legacy { version } => {
            let version = version
                .as_deref()
                .map(parse_protocol_version)
                .transpose()?
                .unwrap_or(ProtocolVersion::V_2025_11_25);
            Ok((
                ClientInfo::new(capabilities, identity).with_protocol_version(version.clone()),
                ClientLifecycleMode::Initialize,
                Some(version),
            ))
        }
        ProtocolSelection::Auto { legacy_version } => {
            let legacy_version = legacy_version
                .as_deref()
                .map(parse_protocol_version)
                .transpose()?
                .unwrap_or(ProtocolVersion::V_2025_11_25);
            Ok((
                ClientInfo::new(capabilities, identity)
                    .with_protocol_version(legacy_version.clone()),
                ClientLifecycleMode::Auto {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                    legacy_version: Some(legacy_version),
                },
                None,
            ))
        }
        ProtocolSelection::Modern => Ok((
            ClientInfo::new(capabilities, identity)
                .with_protocol_version(ProtocolVersion::V_2026_07_28),
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
            Some(ProtocolVersion::V_2026_07_28),
        )),
        ProtocolSelection::Exact { version } => {
            let version = parse_protocol_version(version)?;
            let lifecycle = if version == ProtocolVersion::V_2026_07_28 {
                ClientLifecycleMode::Discover {
                    preferred_versions: vec![version.clone()],
                }
            } else {
                ClientLifecycleMode::Initialize
            };
            Ok((
                ClientInfo::new(capabilities, identity).with_protocol_version(version.clone()),
                lifecycle,
                Some(version),
            ))
        }
    }
}

async fn await_connection<F>(
    connect_future: F,
    timeout_ms: Option<u64>,
) -> Result<LiveSession, ProtocolError>
where
    F: Future<Output = Result<LiveSession, ClientInitializeError>>,
{
    match timeout_ms {
        Some(timeout_ms) => timeout(Duration::from_millis(timeout_ms), connect_future)
            .await
            .map_err(|_| ProtocolError::Timeout(timeout_ms))?
            .map_err(|error| ProtocolError::Connect(error.to_string())),
        None => connect_future
            .await
            .map_err(|error| ProtocolError::Connect(error.to_string())),
    }
}

fn parse_protocol_version(version: &str) -> Result<ProtocolVersion, ProtocolError> {
    if !PUBLISHED_PROTOCOL_VERSIONS.contains(&version) {
        return Err(ProtocolError::UnsupportedVersion(version.to_owned()));
    }
    Ok(serde_json::from_value(Value::String(version.to_owned()))?)
}

fn environment_value(key: &str, value: &Value) -> Result<Option<String>, ProtocolError> {
    match value {
        Value::String(value) => Ok(Some(value.clone())),
        Value::Number(value) => Ok(Some(value.to_string())),
        Value::Bool(value) => Ok(Some(value.to_string())),
        Value::Null => Ok(None),
        _ => Err(ProtocolError::InvalidEnvironmentValue(key.to_owned())),
    }
}

fn parse_headers(
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<HashMap<HeaderName, HeaderValue>, ProtocolError> {
    headers
        .iter()
        .map(|(name, value)| {
            let header_name = name
                .parse::<HeaderName>()
                .map_err(|_| ProtocolError::InvalidHeaderName(name.clone()))?;
            let header_value = value
                .parse::<HeaderValue>()
                .map_err(|_| ProtocolError::InvalidHeaderValue(name.clone()))?;
            Ok((header_name, header_value))
        })
        .collect()
}

fn transport_name(transport: &TransportConfig) -> &'static str {
    match transport {
         TransportConfig::Stdio { .. } => "stdio",
        TransportConfig::Http { .. } => "http",
        TransportConfig::Sse { .. } => "sse",
        TransportConfig::Auto { .. } => "auto",
        TransportConfig::Websocket { .. } => "websocket",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        net::{TcpListener, TcpStream},
        path::PathBuf,
        process::Stdio,
    };

    use super::*;
    use crate::{ConfigSourceKind, FORMAT_VERSION, ProfileSource, REDACTED};

    fn fixture_profile() -> ServerProfile {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/servers/basic-stdio.mjs");
        ServerProfile {
            format_version: FORMAT_VERSION,
            name: "basic-fixture".to_owned(),
            transport: TransportConfig::Stdio {
                command: "node".to_owned(),
                args: vec![fixture.to_string_lossy().into_owned()],
                cwd: None,
                env: BTreeMap::new(),
                env_file: None,
            },
            protocol: ProtocolSelection::Exact {
                version: "2025-11-25".to_owned(),
            },
            source: ProfileSource {
                kind: ConfigSourceKind::Generic,
                path: None,
                scope: None,
            },
            timeout_ms: Some(5_000),
            trusted: true,
        }
    }

    fn http_fixture_profile(port: u16) -> ServerProfile {
        ServerProfile {
            format_version: FORMAT_VERSION,
            name: "http-fixture".to_owned(),
            transport: TransportConfig::Http {
                url: format!("http://127.0.0.1:{port}/mcp"),
                headers: BTreeMap::from([
                    ("X-MCP-Check".to_owned(), "fixture".to_owned()),
                    ("X-API-Key".to_owned(), "http-secret-4d2a".to_owned()),
                ]),
                oauth: None,
            },
            protocol: ProtocolSelection::Exact {
                version: "2025-11-25".to_owned(),
            },
            source: ProfileSource {
                kind: ConfigSourceKind::Generic,
                path: None,
                scope: None,
            },
            timeout_ms: Some(5_000),
            trusted: true,
        }
    }

    async fn wait_for_fixture(port: u16) {
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("HTTP fixture did not start on port {port}");
    }

    #[tokio::test]
    async fn connects_lists_calls_and_disconnects_stdio_server() {
        let manager = SessionManager::default();
        let snapshot = manager.connect(&fixture_profile()).await.unwrap();

        assert_eq!(snapshot.protocol_version, "2025-11-25");
        assert_eq!(snapshot.tools.len(), 1);
        assert_eq!(snapshot.tools[0].name, "echo");
        assert_eq!(snapshot.resources[0]["uri"], "fixture://readme");
        assert_eq!(snapshot.prompts[0]["name"], "greeting");

        let result = manager
            .call_tool(
                "basic-fixture",
                "echo",
                serde_json::json!({ "message": "hello" }),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "hello");

        let resource = manager
            .read_resource("basic-fixture", "fixture://readme")
            .await
            .unwrap();
        assert_eq!(resource["contents"][0]["text"], "Fixture resource");

        let prompt = manager
            .get_prompt(
                "basic-fixture",
                "greeting",
                serde_json::json!({ "name": "Ada" }),
            )
            .await
            .unwrap();
        assert_eq!(prompt["messages"][0]["content"]["text"], "Hello, Ada!");

        manager.disconnect("basic-fixture").await.unwrap();

        let events = manager.events("basic-fixture").await;
        assert_eq!(events.first().unwrap().method, "session/connect");
        assert_eq!(events.last().unwrap().method, "session/disconnect");
        assert!(events.iter().any(|event| {
            event.method == "tools/call"
                && event.direction == ProtocolEventDirection::ClientToServer
        }));
    }

    #[tokio::test]
    async fn redacts_sensitive_arguments_from_protocol_history() {
        let manager = SessionManager::default();
        manager.connect(&fixture_profile()).await.unwrap();
        let sentinel = "protocol-secret-c5f9";

        let response = manager
            .call_tool(
                "basic-fixture",
                "echo",
                serde_json::json!({"message": sentinel, "apiToken": sentinel}),
            )
            .await
            .unwrap();
        manager.disconnect("basic-fixture").await.unwrap();
        let serialized = serde_json::to_string(&manager.events("basic-fixture").await).unwrap();

        assert_eq!(response["content"][0]["text"], REDACTED);
        assert!(!serialized.contains(sentinel));
        assert!(serialized.contains(REDACTED));
    }

    #[tokio::test]
    async fn refuses_untrusted_profiles() {
        let manager = SessionManager::default();
        let mut profile = fixture_profile();
        profile.trusted = false;

        let error = manager.connect(&profile).await.unwrap_err();

        assert!(matches!(error, ProtocolError::UntrustedProfile(_)));
    }

    #[tokio::test]
    async fn connects_lists_calls_and_disconnects_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/servers/basic-http.mjs");
        let mut server = Command::new("node")
            .arg(fixture)
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        wait_for_fixture(port).await;

        let manager = SessionManager::default();
        let snapshot = manager.connect(&http_fixture_profile(port)).await.unwrap();
        assert_eq!(snapshot.protocol_version, "2025-11-25");
        assert_eq!(snapshot.tools[0].name, "echo");

        let result = manager
            .call_tool(
                "http-fixture",
                "echo",
                serde_json::json!({ "message": "over http" }),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "over http");

        manager.disconnect("http-fixture").await.unwrap();
        let observations = manager.http_observations("http-fixture").await;
        assert!(observations.iter().any(|event| event.method == "POST"));
        assert!(observations.iter().any(|event| event.method == "DELETE"));
        assert!(observations.iter().any(|event| {
            event.response_body.as_ref().is_some_and(|body| {
                body["result"]["content"][0]["text"] == "over http"
            })
        }));
        let serialized = serde_json::to_string(&observations).unwrap();
        assert!(!serialized.contains("http-secret-4d2a"));
        assert!(serialized.contains(REDACTED));
        server.kill().await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_legacy_initialize_after_http_discover_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/servers/basic-http.mjs");
        let mut server = Command::new("node")
            .arg(fixture)
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        wait_for_fixture(port).await;
        let mut profile = http_fixture_profile(port);
        profile.protocol = ProtocolSelection::Auto {
            legacy_version: Some("2025-11-25".to_owned()),
        };
        let manager = SessionManager::default();

        let snapshot = manager.connect(&profile).await.unwrap();

        assert_eq!(snapshot.protocol_version, "2025-11-25");
        assert_eq!(snapshot.tools[0].name, "echo");
        manager.disconnect("http-fixture").await.unwrap();
        server.kill().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires MCP_CHECK_TEST_URL and network access"]
    async fn connects_to_external_http_server_when_configured() {
        let url = std::env::var("MCP_CHECK_TEST_URL").expect("MCP_CHECK_TEST_URL is required");
        let profile = ServerProfile {
            format_version: FORMAT_VERSION,
            name: "external-http".to_owned(),
            transport: TransportConfig::Http {
                url,
                headers: BTreeMap::new(),
                oauth: None,
            },
            protocol: ProtocolSelection::Auto {
                legacy_version: Some("2025-11-25".to_owned()),
            },
            source: ProfileSource {
                kind: ConfigSourceKind::Generic,
                path: None,
                scope: None,
            },
            timeout_ms: Some(15_000),
            trusted: true,
        };
        let manager = SessionManager::default();

        let snapshot = manager.connect(&profile).await.unwrap();

        assert!(!snapshot.protocol_version.is_empty());
        manager.disconnect("external-http").await.unwrap();
    }
}
