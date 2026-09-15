use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Instant,
};

use futures::{StreamExt, stream::BoxStream};
use http::{HeaderMap, HeaderName, HeaderValue};
use reqwest::header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::auth::{
        OAuthHttpClient, OAuthHttpClientError, OAuthHttpClientFuture, OAuthHttpRedirectPolicy,
        OAuthHttpRequest,
    },
    transport::streamable_http_client::{
        AuthRequiredError, InsufficientScopeError, SseError, StreamableHttpClient,
        StreamableHttpError, StreamableHttpPostResponse,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sse_stream::Sse;

use crate::Redactor;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpObservation {
    pub sequence: u64,
    pub elapsed_ms: u64,
    pub method: String,
    pub url: String,
    pub request_headers: BTreeMap<String, String>,
    pub request_body: Option<Value>,
    pub response_headers: BTreeMap<String, String>,
    pub response_kind: Option<String>,
    pub response_body: Option<Value>,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

struct RecorderState {
    started: Instant,
    redactor: Redactor,
    observations: Vec<HttpObservation>,
}

#[derive(Clone)]
pub struct TransportRecorder {
    state: Arc<Mutex<RecorderState>>,
}

impl TransportRecorder {
    pub fn new(redactor: Redactor) -> Self {
        Self {
            state: Arc::new(Mutex::new(RecorderState {
                started: Instant::now(),
                redactor,
                observations: Vec::new(),
            })),
        }
    }

    pub fn observations(&self) -> Vec<HttpObservation> {
        self.state
            .lock()
            .expect("transport recorder poisoned")
            .observations
            .clone()
    }

    fn record_request(
        &self,
        request: &reqwest::Request,
        body: Option<&ClientJsonRpcMessage>,
    ) -> usize {
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let body = body.and_then(|body| serde_json::to_value(body).ok());
        if let Some(body) = &body {
            state.redactor.register_sensitive_json(body);
        }
        self.record_request_value_locked(
            &mut state,
            request.method().as_str(),
            request.url().as_str(),
            header_map_to_btree(request.headers()),
            body,
        )
    }

    fn record_request_value_locked(
        &self,
        state: &mut RecorderState,
        method: &str,
        url: &str,
        headers: BTreeMap<String, String>,
        body: Option<Value>,
    ) -> usize {
        let headers = state.redactor.redact_headers(&headers);
        let sequence = state.observations.len() as u64 + 1;
        let observation = HttpObservation {
            sequence,
            elapsed_ms: state.started.elapsed().as_millis() as u64,
            method: method.to_owned(),
            url: state.redactor.redact_text(url),
            request_headers: headers,
            request_body: body.map(|body| state.redactor.redact_json(&body)),
            response_headers: BTreeMap::new(),
            response_kind: None,
            response_body: None,
            session_id: None,
            error: None,
        };
        state.observations.push(observation);
        state.observations.len() - 1
    }

    pub(crate) fn record_bytes_request(
        &self,
        method: &str,
        url: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> usize {
        let headers = header_map_to_btree(headers);
        let body = if body.is_empty() {
            None
        } else if headers
            .get("content-type")
            .is_some_and(|value| value.to_ascii_lowercase().contains("json"))
        {
            serde_json::from_slice(body).ok()
        } else {
            Some(Value::String(crate::REDACTED.to_owned()))
        };
        let mut state = self.state.lock().expect("transport recorder poisoned");
        self.record_request_value_locked(&mut state, method, url, headers, body)
    }

    pub fn record_callback(&self, url: &str, has_error: bool) {
        let url = redact_query_values(url);
        let index = {
            let mut state = self.state.lock().expect("transport recorder poisoned");
            self.record_request_value_locked(&mut state, "GET", &url, BTreeMap::new(), None)
        };
        let response_kind = if has_error {
            "callback 200 (error)"
        } else {
            "callback 200"
        };
        self.finish(index, Some(response_kind), None, None, None);
    }

    pub(crate) fn finish(
        &self,
        index: usize,
        response_kind: Option<&str>,
        response_body: Option<Value>,
        session_id: Option<&str>,
        error: Option<&str>,
    ) {
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let redactor = state.redactor.clone();
        let response_body = response_body.map(|body| redactor.redact_json(&body));
        if let Some(observation) = state.observations.get_mut(index) {
            observation.response_kind = response_kind.map(str::to_owned);
            observation.response_body = response_body;
            observation.session_id = session_id.map(|value| redactor.redact_text(value));
            observation.error = error.map(|value| redactor.redact_text(value));
        }
    }

    fn record_response_headers(&self, index: usize, headers: &HeaderMap) {
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let headers = state.redactor.redact_headers(&header_map_to_btree(headers));
        if let Some(observation) = state.observations.get_mut(index) {
            observation.response_headers = headers;
        }
    }

    fn record_sse_event(&self, index: usize, event: &Sse) {
        let event = serde_json::json!({
            "event": event.event,
            "data": event.data,
            "id": event.id,
            "retry": event.retry,
        });
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let event = state.redactor.redact_json(&event);
        if let Some(observation) = state.observations.get_mut(index) {
            match observation.response_body.as_mut() {
                Some(Value::Array(events)) => events.push(event),
                Some(response) => {
                    let previous = std::mem::take(response);
                    *response = Value::Array(vec![previous, event]);
                }
                None => observation.response_body = Some(Value::Array(vec![event])),
            }
        }
    }
}

fn header_map_to_btree(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for (name, value) in headers {
        let value = value.to_str().unwrap_or("<binary>");
        values
            .entry(name.to_string())
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    values
}

fn redact_query_values(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_owned();
    };
    let keys = parsed
        .query_pairs()
        .map(|(key, _)| key.into_owned())
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return parsed.to_string();
    }
    parsed.set_query(None);
    {
        let mut query = parsed.query_pairs_mut();
        for key in keys {
            query.append_pair(&key, crate::REDACTED);
        }
    }
    parsed.to_string()
}

const MAX_OAUTH_HTTP_RESPONSE_BODY_BYTES: usize = 1024 * 1024;

pub(crate) struct ObservableOAuthHttpClient {
    follow_redirects: reqwest::Client,
    stop_redirects: reqwest::Client,
    recorder: TransportRecorder,
}

impl ObservableOAuthHttpClient {
    pub(crate) fn new(recorder: TransportRecorder) -> Self {
        let follow_redirects = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build OAuth HTTP client");
        let stop_redirects = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build OAuth HTTP client");
        Self {
            follow_redirects,
            stop_redirects,
            recorder,
        }
    }
}

impl OAuthHttpClient for ObservableOAuthHttpClient {
    fn execute(&self, request: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(async move {
            let OAuthHttpRequest {
                request,
                redirect_policy,
                ..
            } = request;
            let index = self.recorder.record_bytes_request(
                request.method().as_str(),
                &request.uri().to_string(),
                request.headers(),
                request.body(),
            );
            let client = match redirect_policy {
                OAuthHttpRedirectPolicy::Follow => &self.follow_redirects,
                OAuthHttpRedirectPolicy::Stop => &self.stop_redirects,
                _ => &self.stop_redirects,
            };
            let request = match reqwest::Request::try_from(request) {
                Ok(request) => request,
                Err(error) => {
                    self.recorder
                        .finish(index, None, None, None, Some(&error.to_string()));
                    return Err(Box::new(error) as OAuthHttpClientError);
                }
            };
            let response = match client.execute(request).await {
                Ok(response) => response,
                Err(error) => {
                    self.recorder
                        .finish(index, None, None, None, Some(&error.to_string()));
                    return Err(Box::new(error) as OAuthHttpClientError);
                }
            };
            let status = response.status();
            let version = response.version();
            let headers = response.headers().clone();
            self.recorder.record_response_headers(index, &headers);
            let mut body = Vec::new();
            let mut body_stream = response.bytes_stream();
            while let Some(chunk) = body_stream.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        self.recorder
                            .finish(index, None, None, None, Some(&error.to_string()));
                        return Err(Box::new(error) as OAuthHttpClientError);
                    }
                };
                if chunk.len() > MAX_OAUTH_HTTP_RESPONSE_BODY_BYTES.saturating_sub(body.len()) {
                    let error = std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!(
                            "OAuth response body exceeds {MAX_OAUTH_HTTP_RESPONSE_BODY_BYTES} bytes"
                        ),
                    );
                    self.recorder
                        .finish(index, None, None, None, Some(&error.to_string()));
                    return Err(Box::new(error) as OAuthHttpClientError);
                }
                body.extend_from_slice(&chunk);
            }
            let response_body = serde_json::from_slice(&body).ok();
            let response_kind = format!("oauth {status}");
            self.recorder
                .finish(index, Some(&response_kind), response_body, None, None);

            let mut builder = http::Response::builder().status(status).version(version);
            for (name, value) in &headers {
                builder = builder.header(name, value);
            }
            builder
                .body(body)
                .map_err(|error| Box::new(error) as OAuthHttpClientError)
        })
    }
}

fn observe_sse_stream(
    stream: BoxStream<'static, Result<Sse, SseError>>,
    recorder: TransportRecorder,
    index: usize,
) -> BoxStream<'static, Result<Sse, SseError>> {
    Box::pin(stream.map(move |result| {
        if let Ok(event) = &result {
            recorder.record_sse_event(index, event);
        }
        result
    }))
}

#[derive(Clone)]
pub struct ObservableHttpClient {
    client: reqwest::Client,
    recorder: TransportRecorder,
}

impl ObservableHttpClient {
    pub fn new(recorder: TransportRecorder) -> Self {
        Self {
            client: reqwest::Client::builder()
                .pool_max_idle_per_host(0)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("failed to build HTTP client"),
            recorder,
        }
    }
}

const EVENT_STREAM_MIME_TYPE: &str = "text/event-stream";
const JSON_MIME_TYPE: &str = "application/json";
const HEADER_SESSION_ID: &str = "Mcp-Session-Id";
const HEADER_LAST_EVENT_ID: &str = "Last-Event-Id";

fn apply_custom_headers(
    mut builder: reqwest::RequestBuilder,
    custom_headers: HashMap<HeaderName, HeaderValue>,
) -> Result<reqwest::RequestBuilder, StreamableHttpError<reqwest::Error>> {
    for (name, value) in custom_headers {
        if matches!(
            name.as_str().to_ascii_lowercase().as_str(),
            "accept" | "mcp-session-id" | "last-event-id"
        ) {
            return Err(StreamableHttpError::ReservedHeaderConflict(
                name.to_string(),
            ));
        }
        builder = builder.header(name, value);
    }
    Ok(builder)
}

fn parse_json_rpc_error(body: &str) -> Option<ServerJsonRpcMessage> {
    match serde_json::from_str::<ServerJsonRpcMessage>(body) {
        Ok(message @ ServerJsonRpcMessage::Error(_)) => Some(message),
        _ => None,
    }
}

fn extract_scope_from_header(header: &str) -> Option<String> {
    let lowercase = header.to_ascii_lowercase();
    let start = lowercase.find("scope=")? + "scope=".len();
    let value = &header[start..];
    if let Some(value) = value.strip_prefix('"') {
        return value.find('"').map(|end| value[..end].to_owned());
    }
    let end = value
        .find(|character: char| character == ',' || character == ';' || character.is_whitespace())
        .unwrap_or(value.len());
    (end > 0).then(|| value[..end].to_owned())
}

fn response_session_id(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(HEADER_SESSION_ID)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn content_type(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).to_string())
}

fn has_content_type(headers: &HashMap<HeaderName, HeaderValue>) -> bool {
    headers.keys().any(|name| name == CONTENT_TYPE)
}

fn bearer_header(
    request: reqwest::RequestBuilder,
    auth_header: Option<String>,
) -> reqwest::RequestBuilder {
    match auth_header {
        Some(auth_header) => request.bearer_auth(auth_header),
        None => request,
    }
}

#[derive(Debug)]
struct SseEventSizeLimiter {
    max_size: usize,
    retained_size: usize,
    line_size: usize,
    line_is_comment: bool,
    previous_was_cr: bool,
}

impl SseEventSizeLimiter {
    fn new(max_size: usize) -> Self {
        Self {
            max_size,
            retained_size: 0,
            line_size: 0,
            line_is_comment: false,
            previous_was_cr: false,
        }
    }

    fn observe(&mut self, chunk: &[u8]) -> Result<(), ()> {
        for &byte in chunk {
            if self.previous_was_cr {
                self.previous_was_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }

            match byte {
                b'\r' => {
                    self.finish_line()?;
                    self.previous_was_cr = true;
                }
                b'\n' => self.finish_line()?,
                _ => {
                    if self.line_size == 0 {
                        self.line_is_comment = byte == b':';
                    }
                    self.line_size = self.line_size.saturating_add(1);
                    self.check_limit()?
                }
            }
        }
        Ok(())
    }

    fn finish_line(&mut self) -> Result<(), ()> {
        if self.line_size == 0 {
            self.retained_size = 0;
        } else if !self.line_is_comment {
            self.retained_size = self
                .retained_size
                .saturating_add(self.line_size)
                .saturating_add(1);
        }
        self.line_size = 0;
        self.line_is_comment = false;
        self.check_limit()
    }

    fn check_limit(&self) -> Result<(), ()> {
        if self.retained_size.saturating_add(self.line_size) > self.max_size {
            Err(())
        } else {
            Ok(())
        }
    }
}

fn bounded_sse_stream<S, E>(
    stream: S,
    max_event_size: usize,
) -> BoxStream<'static, Result<Sse, SseError>>
where
    S: futures::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let stream = futures::stream::unfold(
        (
            Box::pin(stream),
            SseEventSizeLimiter::new(max_event_size),
            false,
        ),
        move |(mut stream, mut limiter, failed)| async move {
            if failed {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => {
                    if limiter.observe(&chunk).is_err() {
                        let error = std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!(
                                "SSE event exceeded the maximum size of {max_event_size} bytes"
                            ),
                        );
                        Some((Err(error), (stream, limiter, true)))
                    } else {
                        Some((Ok(chunk), (stream, limiter, false)))
                    }
                }
                Some(Err(error)) => Some((
                    Err(std::io::Error::other(error.to_string())),
                    (stream, limiter, true),
                )),
                None => None,
            }
        },
    );
    sse_stream::SseStream::from_bytes_stream(stream).boxed()
}

impl StreamableHttpClient for ObservableHttpClient {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            1024 * 1024,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        _max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let has_content_type = has_content_type(&custom_headers);
        let mut builder = self
            .client
            .post(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "));
        builder = bearer_header(builder, auth_header);
        builder = apply_custom_headers(builder, custom_headers)?;
        if !has_content_type {
            builder = builder.header(CONTENT_TYPE, JSON_MIME_TYPE);
        }
        if let Some(session_id) = session_id {
            builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        let body = serde_json::to_vec(&message).map_err(StreamableHttpError::Deserialize)?;
        let request = builder
            .body(body)
            .build()
            .map_err(StreamableHttpError::Client)?;
        let index = self.recorder.record_request(&request, Some(&message));
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(error) => {
                self.recorder
                    .finish(index, None, None, None, Some(&error.to_string()));
                return Err(StreamableHttpError::Client(error));
            }
        };
        self.recorder
            .record_response_headers(index, response.headers());
        let status = response.status();
        let session_id = response_session_id(&response);
        let content_type = content_type(&response);
        if status == reqwest::StatusCode::UNAUTHORIZED
            && let Some(header) = response.headers().get(WWW_AUTHENTICATE)
        {
            let error = match header.to_str() {
                Ok(header) => {
                    StreamableHttpError::AuthRequired(AuthRequiredError::new(header.to_owned()))
                }
                Err(_) => StreamableHttpError::UnexpectedServerResponse(
                    "invalid www-authenticate header value".into(),
                ),
            };
            self.recorder.finish(
                index,
                None,
                None,
                session_id.as_deref(),
                Some(&error.to_string()),
            );
            return Err(error);
        }
        if status == reqwest::StatusCode::FORBIDDEN
            && let Some(header) = response.headers().get(WWW_AUTHENTICATE)
        {
            let error = match header.to_str() {
                Ok(header) => StreamableHttpError::InsufficientScope(InsufficientScopeError::new(
                    header.to_owned(),
                    extract_scope_from_header(header),
                )),
                Err(_) => StreamableHttpError::UnexpectedServerResponse(
                    "invalid www-authenticate header value".into(),
                ),
            };
            self.recorder.finish(
                index,
                None,
                None,
                session_id.as_deref(),
                Some(&error.to_string()),
            );
            return Err(error);
        }
        if matches!(
            status,
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) {
            self.recorder
                .finish(index, Some("accepted"), None, session_id.as_deref(), None);
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == reqwest::StatusCode::NOT_FOUND && session_id.is_some() {
            let error = StreamableHttpError::SessionExpired;
            self.recorder.finish(
                index,
                None,
                None,
                session_id.as_deref(),
                Some(&error.to_string()),
            );
            return Err(error);
        }
        let content_length = response.content_length();
        if status.is_success()
            && content_length == Some(0)
            && matches!(
                &message,
                ClientJsonRpcMessage::Notification(_)
                    | ClientJsonRpcMessage::Response(_)
                    | ClientJsonRpcMessage::Error(_)
            )
        {
            self.recorder
                .finish(index, Some("accepted"), None, session_id.as_deref(), None);
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read response body>".to_owned());
            if content_type
                .as_deref()
                .is_some_and(|value| value.starts_with(JSON_MIME_TYPE))
                && let Some(message) = parse_json_rpc_error(&body)
            {
                let response_body = serde_json::to_value(&message).ok();
                self.recorder.finish(
                    index,
                    Some("json"),
                    response_body,
                    session_id.as_deref(),
                    None,
                );
                return Ok(StreamableHttpPostResponse::Json(message, session_id));
            }
            let error = StreamableHttpError::UnexpectedServerResponse(Cow::Owned(format!(
                "HTTP {status}: {body}"
            )));
            self.recorder.finish(
                index,
                None,
                None,
                session_id.as_deref(),
                Some(&error.to_string()),
            );
            return Err(error);
        }
        match content_type.as_deref() {
            Some(value) if value.starts_with(EVENT_STREAM_MIME_TYPE) => {
                let stream = bounded_sse_stream(response.bytes_stream(), _max_sse_event_size);
                self.recorder
                    .finish(index, Some("sse"), None, session_id.as_deref(), None);
                Ok(StreamableHttpPostResponse::Sse(
                    observe_sse_stream(stream, self.recorder.clone(), index),
                    session_id,
                ))
            }
            Some(value) if value.starts_with(JSON_MIME_TYPE) => {
                match response.json::<ServerJsonRpcMessage>().await {
                    Ok(message) => {
                        let response_body = serde_json::to_value(&message).ok();
                        self.recorder.finish(
                            index,
                            Some("json"),
                            response_body,
                            session_id.as_deref(),
                            None,
                        );
                        Ok(StreamableHttpPostResponse::Json(message, session_id))
                    }
                    Err(_) => {
                        self.recorder.finish(
                            index,
                            Some("accepted"),
                            None,
                            session_id.as_deref(),
                            None,
                        );
                        Ok(StreamableHttpPostResponse::Accepted)
                    }
                }
            }
            _ => {
                let error = StreamableHttpError::UnexpectedContentType(content_type);
                self.recorder.finish(
                    index,
                    None,
                    None,
                    session_id.as_deref(),
                    Some(&error.to_string()),
                );
                Err(error)
            }
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let mut builder = self.client.delete(uri.as_ref());
        builder = bearer_header(builder, auth_header);
        builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
        builder = apply_custom_headers(builder, custom_headers)?;
        let request = builder.build().map_err(StreamableHttpError::Client)?;
        let index = self.recorder.record_request(&request, None);
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(error) => {
                self.recorder
                    .finish(index, None, None, None, Some(&error.to_string()));
                return Err(StreamableHttpError::Client(error));
            }
        };
        self.recorder
            .record_response_headers(index, response.headers());
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            self.recorder.finish(index, Some("empty"), None, None, None);
            return Ok(());
        }
        match response.error_for_status() {
            Ok(_) => {
                self.recorder.finish(index, Some("empty"), None, None, None);
                Ok(())
            }
            Err(error) => {
                self.recorder
                    .finish(index, None, None, None, Some(&error.to_string()));
                Err(StreamableHttpError::Client(error))
            }
        }
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            1024 * 1024,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        let mut builder = self
            .client
            .get(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "));
        if let Some(session_id) = session_id {
            builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        if let Some(last_event_id) = last_event_id {
            builder = builder.header(HEADER_LAST_EVENT_ID, last_event_id);
        }
        builder = bearer_header(builder, auth_header);
        builder = apply_custom_headers(builder, custom_headers)?;
        let request = builder.build().map_err(StreamableHttpError::Client)?;
        let index = self.recorder.record_request(&request, None);
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(error) => {
                self.recorder
                    .finish(index, None, None, None, Some(&error.to_string()));
                return Err(StreamableHttpError::Client(error));
            }
        };
        self.recorder
            .record_response_headers(index, response.headers());
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            let error = StreamableHttpError::ServerDoesNotSupportSse;
            self.recorder
                .finish(index, None, None, None, Some(&error.to_string()));
            return Err(error);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED
            && let Some(header) = response.headers().get(WWW_AUTHENTICATE)
        {
            let error = match header.to_str() {
                Ok(header) => {
                    StreamableHttpError::AuthRequired(AuthRequiredError::new(header.to_owned()))
                }
                Err(_) => StreamableHttpError::UnexpectedServerResponse(
                    "invalid www-authenticate header value".into(),
                ),
            };
            self.recorder
                .finish(index, None, None, None, Some(&error.to_string()));
            return Err(error);
        }
        if response.status() == reqwest::StatusCode::FORBIDDEN
            && let Some(header) = response.headers().get(WWW_AUTHENTICATE)
        {
            let error = match header.to_str() {
                Ok(header) => StreamableHttpError::InsufficientScope(InsufficientScopeError::new(
                    header.to_owned(),
                    extract_scope_from_header(header),
                )),
                Err(_) => StreamableHttpError::UnexpectedServerResponse(
                    "invalid www-authenticate header value".into(),
                ),
            };
            self.recorder
                .finish(index, None, None, None, Some(&error.to_string()));
            return Err(error);
        }
        let content_type = content_type(&response);
        let response = match response.error_for_status() {
            Ok(response) => response,
            Err(error) => {
                self.recorder
                    .finish(index, None, None, None, Some(&error.to_string()));
                return Err(StreamableHttpError::Client(error));
            }
        };
        if !content_type.as_deref().is_some_and(|value| {
            value.starts_with(EVENT_STREAM_MIME_TYPE) || value.starts_with(JSON_MIME_TYPE)
        }) {
            let error = StreamableHttpError::UnexpectedContentType(content_type);
            self.recorder
                .finish(index, None, None, None, Some(&error.to_string()));
            return Err(error);
        }
        let stream = bounded_sse_stream(response.bytes_stream(), max_sse_event_size);
        self.recorder.finish(index, Some("sse"), None, None, None);
        Ok(observe_sse_stream(stream, self.recorder.clone(), index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::REDACTED;

    #[test]
    fn redacts_callback_query_values() {
        let recorder = TransportRecorder::new(Redactor::default());

        recorder.record_callback(
            "http://127.0.0.1:43121/oauth/callback?code=authorization-code&state=csrf-state",
            false,
        );

        let observation = recorder.observations().pop().unwrap();
        assert!(observation.url.contains("code="));
        assert!(observation.url.contains("state="));
        assert!(!observation.url.contains("authorization-code"));
        assert!(!observation.url.contains("csrf-state"));
        assert_eq!(observation.response_kind.as_deref(), Some("callback 200"));
    }

    #[test]
    fn captures_and_redacts_request_and_response_headers() {
        let recorder = TransportRecorder::new(Redactor::default());
        let request = reqwest::Client::new()
            .post("https://example.test/mcp")
            .bearer_auth("oauth-secret")
            .build()
            .unwrap();
        let index = recorder.record_request(&request, None);
        let mut response_headers = HeaderMap::new();
        response_headers.insert("content-type", HeaderValue::from_static("application/json"));
        response_headers.insert("set-cookie", HeaderValue::from_static("session-secret"));
        recorder.record_response_headers(index, &response_headers);

        let observation = recorder.observations().pop().unwrap();
        assert_eq!(observation.request_headers["authorization"], REDACTED);
        assert_eq!(
            observation.response_headers["content-type"],
            "application/json"
        );
        assert_eq!(observation.response_headers["set-cookie"], REDACTED);
    }

    #[test]
    fn redacts_oauth_form_bodies() {
        let recorder = TransportRecorder::new(Redactor::default());
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );

        recorder.record_bytes_request(
            "POST",
            "https://auth.example.test/token",
            &headers,
            b"grant_type=authorization_code&code=authorization-code&code_verifier=pkce-verifier",
        );

        let observation = recorder.observations().pop().unwrap();
        assert_eq!(
            observation.request_body,
            Some(Value::String(crate::REDACTED.to_owned()))
        );
    }
}
