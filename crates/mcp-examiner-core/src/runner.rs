use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AssertionOutcome, ConnectionSnapshot, FORMAT_VERSION, HttpObservation, ProtocolEvent, Redactor,
    ResolutionContext, ServerProfile, SessionManager, TestCall, TestSet, assert_response,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Passed,
    Failed,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRunResult {
    pub index: usize,
    pub operation: String,
    pub target: String,
    pub definition: TestCall,
    pub status: RunStatus,
    pub duration_ms: u64,
    pub response: Option<Value>,
    pub assertions: Vec<AssertionOutcome>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    pub format_version: u32,
    pub name: String,
    pub description: Option<String>,
    pub server_name: String,
    pub server_profile: ServerProfile,
    pub server_snapshot: Option<ConnectionSnapshot>,
    pub protocol_version: Option<String>,
    pub status: RunStatus,
    pub started_at_unix_ms: u64,
    pub duration_ms: u64,
    pub summary: RunSummary,
    pub calls: Vec<CallRunResult>,
    pub protocol_events: Vec<ProtocolEvent>,
    pub http_observations: Vec<HttpObservation>,
    pub connection_error: Option<String>,
    pub shutdown_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunProgress {
    Started {
        name: String,
        total: usize,
        calls: Vec<PendingCall>,
    },
    Connected {
        protocol_version: String,
    },
    CallStarted {
        index: usize,
        operation: String,
        target: String,
    },
    CallFinished {
        call: Box<CallRunResult>,
        summary: RunSummary,
    },
    ConnectionFailed {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCall {
    pub index: usize,
    pub operation: String,
    pub target: String,
}

pub async fn run_test_set(
    sessions: &SessionManager,
    profile: &ServerProfile,
    context: &ResolutionContext,
    test_set: &TestSet,
) -> TestRunResult {
    run_test_set_with_progress(sessions, profile, context, test_set, |_| {}).await
}

pub async fn run_test_set_with_progress<F>(
    sessions: &SessionManager,
    profile: &ServerProfile,
    context: &ResolutionContext,
    test_set: &TestSet,
    mut progress: F,
) -> TestRunResult
where
    F: FnMut(RunProgress) + Send,
{
    let started = Instant::now();
    let mut redactor = Redactor::for_connection(profile, context);
    let mut result = TestRunResult {
        format_version: FORMAT_VERSION,
        name: test_set.name.clone(),
        description: test_set.description.clone(),
        server_name: profile.name.clone(),
        server_profile: redactor.redact_profile(profile),
        server_snapshot: None,
        protocol_version: None,
        status: RunStatus::Error,
        started_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64),
        duration_ms: 0,
        summary: RunSummary {
            total: test_set.calls.len(),
            passed: 0,
            failed: 0,
            errors: 0,
        },
        calls: Vec::with_capacity(test_set.calls.len()),
        protocol_events: Vec::new(),
        http_observations: Vec::new(),
        connection_error: None,
        shutdown_error: None,
    };
    progress(RunProgress::Started {
        name: test_set.name.clone(),
        total: test_set.calls.len(),
        calls: test_set
            .calls
            .iter()
            .enumerate()
            .map(|(offset, call)| PendingCall {
                index: offset + 1,
                operation: call.operation().to_owned(),
                target: call.target().to_owned(),
            })
            .collect(),
    });

    match sessions.connect_with_context(profile, context).await {
        Ok(snapshot) => {
            result.protocol_version = Some(snapshot.protocol_version.clone());
            progress(RunProgress::Connected {
                protocol_version: snapshot.protocol_version.clone(),
            });
            result.server_snapshot = Some(snapshot);
        }
        Err(error) => {
            let error = redactor.redact_text(&error.to_string());
            progress(RunProgress::ConnectionFailed {
                error: error.clone(),
            });
            result.connection_error = Some(error);
            result.summary.errors = test_set.calls.len();
            result.duration_ms = elapsed_ms(started);
            return result;
        }
    }

    for (offset, call) in test_set.calls.iter().enumerate() {
        progress(RunProgress::CallStarted {
            index: offset + 1,
            operation: call.operation().to_owned(),
            target: call.target().to_owned(),
        });
        let definition_value = serde_json::to_value(call).unwrap_or(Value::Null);
        redactor.register_sensitive_json(&definition_value);
        let definition = serde_json::from_value(redactor.redact_json(&definition_value))
            .unwrap_or_else(|_| call.clone());
        let call_started = Instant::now();
        let response = execute_call(sessions, &profile.name, call).await;
        let call_result = match response {
            Ok(response) => {
                let response = redactor.redact_json(&response);
                let assertions = assert_response(&response, call.expectation());
                let status = if assertions.iter().all(|assertion| assertion.passed) {
                    RunStatus::Passed
                } else {
                    RunStatus::Failed
                };
                CallRunResult {
                    index: offset + 1,
                    operation: call.operation().to_owned(),
                    target: call.target().to_owned(),
                    definition,
                    status,
                    duration_ms: elapsed_ms(call_started),
                    response: Some(response),
                    assertions,
                    error: None,
                }
            }
            Err(error) => CallRunResult {
                index: offset + 1,
                operation: call.operation().to_owned(),
                target: call.target().to_owned(),
                definition,
                status: RunStatus::Error,
                duration_ms: elapsed_ms(call_started),
                response: None,
                assertions: Vec::new(),
                error: Some(redactor.redact_text(&error)),
            },
        };
        match call_result.status {
            RunStatus::Passed => result.summary.passed += 1,
            RunStatus::Failed => result.summary.failed += 1,
            RunStatus::Error => result.summary.errors += 1,
        }
        progress(RunProgress::CallFinished {
            call: Box::new(call_result.clone()),
            summary: result.summary.clone(),
        });
        result.calls.push(call_result);
    }

    if let Err(error) = sessions.disconnect(&profile.name).await {
        result.shutdown_error = Some(redactor.redact_text(&error.to_string()));
    }
    result.protocol_events = sessions.events(&profile.name).await;
    result.http_observations = sessions.http_observations(&profile.name).await;
    result.status = if result.shutdown_error.is_some() || result.summary.errors > 0 {
        RunStatus::Error
    } else if result.summary.failed > 0 {
        RunStatus::Failed
    } else {
        RunStatus::Passed
    };
    result.duration_ms = elapsed_ms(started);
    result
}

async fn execute_call(
    sessions: &SessionManager,
    server_name: &str,
    call: &TestCall,
) -> Result<Value, String> {
    match call {
        TestCall::CallTool {
            name, arguments, ..
        } => sessions
            .call_tool(server_name, name, Value::Object(arguments.clone()))
            .await
            .map_err(|error| error.to_string()),
        TestCall::ReadResource { uri, .. } => sessions
            .read_resource(server_name, uri)
            .await
            .map_err(|error| error.to_string()),
        TestCall::GetPrompt {
            name, arguments, ..
        } => sessions
            .get_prompt(server_name, name, Value::Object(arguments.clone()))
            .await
            .map_err(|error| error.to_string()),
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf};

    use super::*;
    use crate::{
        ConfigSourceKind, ProfileSource, ProtocolSelection, TransportConfig, parse_test_set,
    };

    #[tokio::test]
    async fn runs_schema_calls_sequentially_and_collects_failures() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/servers/basic-stdio.mjs");
        let profile = ServerProfile {
            format_version: FORMAT_VERSION,
            name: "runner-fixture".to_owned(),
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
        };
        let test_set = parse_test_set(
                        r#"{
    "name": "Runner fixture",
    "calls": [
        {
            "type": "callTool",
            "name": "echo",
            "arguments": {"message": "hello", "apiToken": "runner-secret-28b4"},
            "expect": {"contains": "hello"}
        },
        {
            "type": "readResource",
            "uri": "fixture://readme",
            "expect": {"json": {"contents": [{"uri": "fixture://readme", "mimeType": "text/plain", "text": "Fixture resource"}]}}
        },
        {
            "type": "getPrompt",
            "name": "greeting",
            "arguments": {"name": "Ada"},
            "expect": {"contains": "Nobody"}
        }
    ]
}"#,
                )
        .unwrap();
        let sessions = SessionManager::default();
        let mut progress = Vec::new();

        let result = run_test_set_with_progress(
            &sessions,
            &profile,
            &ResolutionContext::from_process(),
            &test_set,
            |event| progress.push(event),
        )
        .await;

        assert_eq!(result.status, RunStatus::Failed);
        assert_eq!(result.summary.passed, 2);
        assert_eq!(result.summary.failed, 1);
        assert_eq!(result.summary.errors, 0);
        assert_eq!(result.protocol_version.as_deref(), Some("2025-11-25"));
        assert!(result.connection_error.is_none());
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("runner-secret-28b4"));
        assert!(serialized.contains(crate::REDACTED));
        assert_eq!(
            result.protocol_events.first().unwrap().method,
            "session/connect"
        );
        assert_eq!(
            result.protocol_events.last().unwrap().method,
            "session/disconnect"
        );
        assert!(
            result
                .protocol_events
                .iter()
                .any(|event| event.method == "resources/read")
        );
        assert!(matches!(
            progress.first(),
            Some(RunProgress::Started { total: 3, .. })
        ));
        assert!(matches!(
            progress.get(1),
            Some(RunProgress::Connected { .. })
        ));
        assert_eq!(
            progress
                .iter()
                .filter(|event| matches!(event, RunProgress::CallStarted { .. }))
                .count(),
            3
        );
        assert_eq!(
            progress
                .iter()
                .filter(|event| matches!(event, RunProgress::CallFinished { .. }))
                .count(),
            3
        );
    }
}
