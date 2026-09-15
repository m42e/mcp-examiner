use std::sync::Arc;

use mcp_examiner_core::{
    AppInfo, ConfigSourceKind, ConnectionSnapshot, HttpObservation, ImportResult,
    OAuthCredentialStore, ProtocolEvent, Redactor, ResolutionContext, RunProgress, ServerProfile,
    SessionManager, TestRunResult, TransportConfig, import_config, parse_test_set,
    render_html_report, render_yaml_report, resolve_profile, run_test_set_with_oauth_store,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, State, ipc::Channel};

mod oauth;
mod secrets;

#[cfg(all(debug_assertions, not(feature = "custom-protocol")))]
use std::{
    net::TcpStream,
    path::Path,
    process::{Child, Command},
    thread,
    time::Duration,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallRequest {
    server_name: String,
    tool_name: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisconnectRequest {
    server_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceReadRequest {
    server_name: String,
    uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptGetRequest {
    server_name: String,
    prompt_name: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomatedRunRequest {
    profile: ServerProfile,
    content: String,
    context: Option<ResolutionContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthLoginRequest {
    profile: ServerProfile,
    context: Option<ResolutionContext>,
    #[serde(default)]
    use_dynamic_registration: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthCancelRequest {
    server_name: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomatedRunResponse {
    result: TestRunResult,
    report_html: String,
    report_yaml: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveReportRequest {
    html_path: String,
    html: String,
    yaml: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveReportResponse {
    html_path: String,
    yaml_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocumentRequest {
    path: String,
    content: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo::current()
}

#[tauri::command]
fn read_document(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_document(request: WriteDocumentRequest) -> Result<String, String> {
    let path = std::path::PathBuf::from(request.path);
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, request.content).map_err(|error| error.to_string())?;
    path.canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_secrets(app: AppHandle) -> Result<Vec<secrets::SecretSummary>, String> {
    secrets::list(&app)
}

#[tauri::command]
fn set_secret(
    app: AppHandle,
    request: secrets::SetSecretRequest,
) -> Result<secrets::SecretSummary, String> {
    secrets::set(&app, request)
}

#[tauri::command]
fn get_secret(id: String) -> Result<String, String> {
    secrets::get(&id)
}

#[tauri::command]
fn delete_secret(app: AppHandle, id: String) -> Result<(), String> {
    secrets::delete(&app, &id)
}

#[tauri::command]
async fn list_oauth_credentials(
    profiles: Vec<ServerProfile>,
) -> Result<Vec<secrets::OAuthCredentialSummary>, String> {
    secrets::list_oauth_credentials(&profiles).await
}

#[tauri::command]
async fn delete_oauth_token(id: String) -> Result<(), String> {
    secrets::delete_oauth_token(&id).await
}

#[tauri::command]
async fn delete_dynamic_client(id: String) -> Result<(), String> {
    secrets::delete_dynamic_client(&id).await
}

#[tauri::command]
fn import_config_preview(content: &str, source: ConfigSourceKind) -> Result<ImportResult, String> {
    import_config(content, source, None).map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_test_set(content: &str) -> Result<usize, String> {
    parse_test_set(content)
        .map(|test_set| test_set.calls.len())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn run_automated_test(
    request: AutomatedRunRequest,
    on_progress: Channel<RunProgress>,
    sessions: State<'_, SessionManager>,
) -> Result<AutomatedRunResponse, String> {
    let test_set = parse_test_set(&request.content).map_err(|error| error.to_string())?;
    let mut context = ResolutionContext::from_process();
    if let Some(request_context) = request.context {
        if request_context.workspace_folder.is_some() {
            context.workspace_folder = request_context.workspace_folder;
        }
        context.environment.extend(request_context.environment);
        context.inputs = request_context.inputs;
    }
    secrets::hydrate_context(&request.profile, &mut context);
    let oauth_store = match &request.profile.transport {
        TransportConfig::Http { .. }
        | TransportConfig::Sse { .. }
        | TransportConfig::Auto { .. } => {
            let resolved_profile =
                resolve_profile(&request.profile, &context).map_err(|error| error.to_string())?;
            Some(Arc::new(secrets::oauth_store(&resolved_profile)?) as Arc<dyn OAuthCredentialStore>)
        }
        _ => None,
    };
    let result = run_test_set_with_oauth_store(
        &sessions,
        &request.profile,
        &context,
        &test_set,
        oauth_store,
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await;
    let report_html = render_html_report(&result);
    let report_yaml = render_yaml_report(&result).map_err(|error| error.to_string())?;
    Ok(AutomatedRunResponse {
        result,
        report_html,
        report_yaml,
    })
}

#[tauri::command]
fn save_report_bundle(request: SaveReportRequest) -> Result<SaveReportResponse, String> {
    let mut html_path = std::path::PathBuf::from(request.html_path);
    if html_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("html")
    {
        html_path.set_extension("html");
    }
    if html_path.is_relative() {
        html_path = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(html_path);
    }
    if let Some(parent) = html_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let yaml_path = html_path.with_extension("yaml");
    std::fs::write(&html_path, request.html).map_err(|error| error.to_string())?;
    std::fs::write(&yaml_path, request.yaml).map_err(|error| error.to_string())?;
    Ok(SaveReportResponse {
        html_path: html_path.to_string_lossy().into_owned(),
        yaml_path: yaml_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn connect_server(
    profile: ServerProfile,
    context: Option<ResolutionContext>,
    sessions: State<'_, SessionManager>,
) -> Result<ConnectionSnapshot, String> {
    eprintln!(
        "MCP Examiner: connecting '{}' with {:?}",
        profile.name, profile.protocol
    );
    let mut resolved_context = ResolutionContext::from_process();
    if let Some(context) = context {
        if context.workspace_folder.is_some() {
            resolved_context.workspace_folder = context.workspace_folder;
        }
        resolved_context.environment.extend(context.environment);
        resolved_context.inputs = context.inputs;
    }
    secrets::hydrate_context(&profile, &mut resolved_context);
    let redactor = Redactor::for_connection(&profile, &resolved_context);
    let resolved_profile =
        resolve_profile(&profile, &resolved_context).map_err(|error| error.to_string())?;
    let oauth_store = match &resolved_profile.transport {
        TransportConfig::Http { .. }
        | TransportConfig::Sse { .. }
        | TransportConfig::Auto { .. } => {
            Some(Arc::new(secrets::oauth_store(&resolved_profile)?) as Arc<dyn OAuthCredentialStore>)
        }
        _ => None,
    };
    let result = sessions
        .connect_with_context_and_oauth_store(&profile, &resolved_context, oauth_store)
        .await;
    match result {
        Ok(snapshot) => {
            eprintln!(
                "MCP Examiner: connected '{}' using protocol {}",
                profile.name, snapshot.protocol_version
            );
            Ok(snapshot)
        }
        Err(error) => {
            let error = redactor.redact_text(&error.to_string());
            eprintln!(
                "MCP Examiner: connection '{}' failed: {error}",
                profile.name
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn oauth_login(
    app: AppHandle,
    request: OAuthLoginRequest,
    oauth_logins: State<'_, oauth::OAuthLoginState>,
    sessions: State<'_, SessionManager>,
) -> Result<(), String> {
    let mut context = ResolutionContext::from_process();
    if let Some(request_context) = request.context {
        if request_context.workspace_folder.is_some() {
            context.workspace_folder = request_context.workspace_folder;
        }
        context.environment.extend(request_context.environment);
        context.inputs = request_context.inputs;
    }
    secrets::hydrate_context(&request.profile, &mut context);
    let profile = resolve_profile(&request.profile, &context).map_err(|error| error.to_string())?;
    if !profile.trusted {
        return Err(format!(
            "server profile '{}' has not been trusted",
            profile.name
        ));
    }
    let redactor = Redactor::for_connection(&profile, &context);
    let server_name = profile.name.clone();
    let cancellation = oauth_logins.begin(&server_name)?;
    let recorder = sessions
        .oauth_transport_recorder(&server_name, redactor.clone())
        .await;
    let result = oauth::login(
        app,
        profile,
        recorder,
        cancellation,
        request.use_dynamic_registration,
    )
    .await;
    oauth_logins.finish(&server_name)?;
    result.map_err(|error| redactor.redact_text(&error))
}

#[tauri::command]
fn oauth_cancel(
    request: OAuthCancelRequest,
    oauth_logins: State<'_, oauth::OAuthLoginState>,
) -> Result<(), String> {
    oauth_logins.cancel(&request.server_name)
}

#[tauri::command]
async fn call_tool(
    request: ToolCallRequest,
    sessions: State<'_, SessionManager>,
) -> Result<Value, String> {
    sessions
        .call_tool(&request.server_name, &request.tool_name, request.arguments)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn disconnect_server(
    request: DisconnectRequest,
    sessions: State<'_, SessionManager>,
) -> Result<(), String> {
    sessions
        .disconnect(&request.server_name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn session_events(
    request: DisconnectRequest,
    sessions: State<'_, SessionManager>,
) -> Result<Vec<ProtocolEvent>, String> {
    Ok(sessions.events(&request.server_name).await)
}

#[tauri::command]
async fn http_observations(
    request: DisconnectRequest,
    sessions: State<'_, SessionManager>,
) -> Result<Vec<HttpObservation>, String> {
    Ok(sessions.http_observations(&request.server_name).await)
}

#[tauri::command]
async fn read_resource(
    request: ResourceReadRequest,
    sessions: State<'_, SessionManager>,
) -> Result<Value, String> {
    sessions
        .read_resource(&request.server_name, &request.uri)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_prompt(
    request: PromptGetRequest,
    sessions: State<'_, SessionManager>,
) -> Result<Value, String> {
    sessions
        .get_prompt(
            &request.server_name,
            &request.prompt_name,
            request.arguments,
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(debug_assertions, not(feature = "custom-protocol")))]
    let _dev_server = ensure_dev_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(oauth::OAuthLoginState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            read_document,
            write_document,
            list_secrets,
            set_secret,
            get_secret,
            delete_secret,
            list_oauth_credentials,
            delete_oauth_token,
            delete_dynamic_client,
            import_config_preview,
            validate_test_set,
            run_automated_test,
            save_report_bundle,
            connect_server,
            oauth_login,
            oauth_cancel,
            call_tool,
            disconnect_server,
            session_events,
            http_observations,
            read_resource,
            get_prompt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(debug_assertions, not(feature = "custom-protocol")))]
struct DevServer(Child);

#[cfg(all(debug_assertions, not(feature = "custom-protocol")))]
impl Drop for DevServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(all(debug_assertions, not(feature = "custom-protocol")))]
fn ensure_dev_server() -> Option<DevServer> {
    if TcpStream::connect(("127.0.0.1", 1420)).is_ok() {
        return None;
    }

    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Tauri crate must be inside the workspace");
    eprintln!("MCP Examiner: starting Vite for cargo run");
    let server = DevServer(
        Command::new("npm")
            .args(["run", "dev", "--", "--host", "127.0.0.1"])
            .current_dir(workspace)
            .spawn()
            .expect("failed to start Vite; install Node dependencies with npm install"),
    );

    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", 1420)).is_ok() {
            return Some(server);
        }
        thread::sleep(Duration::from_millis(50));
    }

    panic!("Vite did not start at http://127.0.0.1:1420");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_utf8_documents() {
        let directory =
            std::env::temp_dir().join(format!("mcp-examiner-documents-{}", std::process::id()));
        let path = directory.join("nested").join("mcp-test.yaml");
        let content = "name: Saved test\ncalls: []\n";

        let saved = write_document(WriteDocumentRequest {
            path: path.to_string_lossy().into_owned(),
            content: content.to_owned(),
        })
        .unwrap();

        assert_eq!(read_document(&saved).unwrap(), content);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
