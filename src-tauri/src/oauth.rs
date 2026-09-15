use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use mcp_examiner_core::{
    OAuthRegistrationPreference, ServerProfile, TransportRecorder,
    start_oauth_authorization_with_recorder_and_preference,
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
    time::timeout,
};

use crate::secrets;

const CALLBACK_PATH: &str = "/oauth/callback";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct OAuthLoginState {
    cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl OAuthLoginState {
    pub fn begin(&self, server_name: &str) -> Result<watch::Receiver<bool>, String> {
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "Could not access OAuth login state.".to_owned())?;
        if cancellations.contains_key(server_name) {
            return Err("OAuth login is already in progress for this server.".to_owned());
        }
        let (sender, receiver) = watch::channel(false);
        cancellations.insert(server_name.to_owned(), sender);
        Ok(receiver)
    }

    pub fn cancel(&self, server_name: &str) -> Result<(), String> {
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "Could not access OAuth login state.".to_owned())?;
        let Some(sender) = cancellations.get(server_name) else {
            return Err("No OAuth login is in progress for this server.".to_owned());
        };
        sender
            .send(true)
            .map_err(|_| "OAuth login is no longer active.".to_owned())
    }

    pub fn finish(&self, server_name: &str) -> Result<(), String> {
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "Could not access OAuth login state.".to_owned())?;
        cancellations.remove(server_name);
        Ok(())
    }
}

pub async fn login(
    app: AppHandle,
    profile: ServerProfile,
    recorder: TransportRecorder,
    mut cancellation: watch::Receiver<bool>,
    use_dynamic_registration: bool,
) -> Result<(), String> {
    let callback_port = configured_callback_port(&profile)?;
    let listener = TcpListener::bind(("127.0.0.1", callback_port.unwrap_or(0)))
        .await
        .map_err(|error| format!("Could not start the OAuth callback listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not determine the OAuth callback port: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let store = Arc::new(secrets::oauth_store(&profile)?);
    let preference = if use_dynamic_registration {
        OAuthRegistrationPreference::DynamicClientRegistration
    } else {
        OAuthRegistrationPreference::Automatic
    };
    let authorization = tokio::select! {
        result = start_oauth_authorization_with_recorder_and_preference(
            &profile,
            redirect_uri,
            store,
            Some(recorder.clone()),
            preference,
        ) => {
            result.map_err(|error| error.to_string())?
        }
        _ = wait_for_cancellation(&mut cancellation) => {
            return Err("OAuth login cancelled.".to_owned());
        }
    };

    app.opener()
        .open_url(authorization.authorization_url().to_owned(), None::<String>)
        .map_err(|error| format!("Could not open the OAuth authorization page: {error}"))?;

    let callback_url = tokio::select! {
        result = timeout(CALLBACK_TIMEOUT, wait_for_callback(listener, recorder.clone())) => {
            result
                .map_err(|_| "OAuth login timed out waiting for the browser callback.".to_owned())??
        }
        _ = wait_for_cancellation(&mut cancellation) => {
            return Err("OAuth login cancelled.".to_owned());
        }
    };
    authorization
        .complete(&callback_url)
        .await
        .map_err(|error| error.to_string())
}

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    while !*cancellation.borrow() {
        if cancellation.changed().await.is_err() {
            return;
        }
    }
}

fn configured_callback_port(profile: &ServerProfile) -> Result<Option<u16>, String> {
    match &profile.transport {
        mcp_examiner_core::TransportConfig::Http { oauth, .. }
        | mcp_examiner_core::TransportConfig::Sse { oauth, .. }
        | mcp_examiner_core::TransportConfig::Auto { oauth, .. } => {
            Ok(oauth.as_ref().and_then(|oauth| oauth.callback_port))
        }
        _ => Err("OAuth login requires an OAuth-enabled HTTP server.".to_owned()),
    }
}

async fn wait_for_callback(
    listener: TcpListener,
    recorder: TransportRecorder,
) -> Result<String, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|error| format!("OAuth callback listener failed: {error}"))?;
        if !peer.ip().is_loopback() {
            write_response(&mut stream, "400 Bad Request", "Invalid callback host.").await?;
            continue;
        }

        let request = read_request(&mut stream).await?;
        let mut parts = request.split_whitespace();
        let method = parts.next();
        let target = parts.next();
        if method != Some("GET") {
            write_response(
                &mut stream,
                "405 Method Not Allowed",
                "Use the browser callback.",
            )
            .await?;
            continue;
        }
        let Some(target) = target else {
            write_response(&mut stream, "400 Bad Request", "Invalid callback request.").await?;
            continue;
        };
        if !(target == CALLBACK_PATH || target.starts_with(&format!("{CALLBACK_PATH}?"))) {
            write_response(&mut stream, "404 Not Found", "Unknown callback path.").await?;
            continue;
        }

        let has_error = target.contains("error=");
        let message = if has_error {
            "OAuth login was not completed. You can close this window."
        } else {
            "OAuth login completed. You can close this window."
        };
        write_response(&mut stream, "200 OK", message).await?;
        recorder.record_callback(&format!("http://127.0.0.1{target}"), has_error);
        return Ok(format!("http://127.0.0.1{target}"));
    }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while buffer.len() < MAX_CALLBACK_REQUEST_BYTES {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Could not read the OAuth callback: {error}"))?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if buffer.len() >= MAX_CALLBACK_REQUEST_BYTES {
        return Err("OAuth callback request is too large.".to_owned());
    }
    String::from_utf8(buffer).map_err(|_| "OAuth callback request was not valid UTF-8.".to_owned())
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    message: &str,
) -> Result<(), String> {
    let body = format!("<!doctype html><html><body><p>{message}</p></body></html>");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| format!("Could not respond to the OAuth callback: {error}"))
}
