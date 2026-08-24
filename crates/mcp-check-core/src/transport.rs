use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Instant,
};

use futures::stream::BoxStream;
use http::{HeaderName, HeaderValue};
use rmcp::{
    model::ClientJsonRpcMessage,
    transport::streamable_http_client::{
        SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
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
    pub response_kind: Option<String>,
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
        method: &str,
        url: &str,
        headers: &HashMap<HeaderName, HeaderValue>,
        body: Option<&ClientJsonRpcMessage>,
    ) -> usize {
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let body = body.and_then(|body| serde_json::to_value(body).ok());
        if let Some(body) = &body {
            state.redactor.register_sensitive_json(body);
        }
        let headers = headers
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    value.to_str().unwrap_or("<binary>").to_owned(),
                )
            })
            .collect();
        let headers = state.redactor.redact_headers(&headers);
        let sequence = state.observations.len() as u64 + 1;
        let observation = HttpObservation {
            sequence,
            elapsed_ms: state.started.elapsed().as_millis() as u64,
            method: method.to_owned(),
            url: state.redactor.redact_text(url),
            request_headers: headers,
            request_body: body.map(|body| state.redactor.redact_json(&body)),
            response_kind: None,
            session_id: None,
            error: None,
        };
        state.observations.push(observation);
        state.observations.len() - 1
    }

    fn finish(
        &self,
        index: usize,
        response_kind: Option<&str>,
        session_id: Option<&str>,
        error: Option<&str>,
    ) {
        let mut state = self.state.lock().expect("transport recorder poisoned");
        let redactor = state.redactor.clone();
        if let Some(observation) = state.observations.get_mut(index) {
            observation.response_kind = response_kind.map(str::to_owned);
            observation.session_id = session_id.map(|value| redactor.redact_text(value));
            observation.error = error.map(|value| redactor.redact_text(value));
        }
    }
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
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let index = self
            .recorder
            .record_request("POST", &uri, &custom_headers, Some(&message));
        let result =
            <reqwest::Client as StreamableHttpClient>::post_message_with_max_sse_event_size(
                &self.client,
                uri,
                message,
                session_id,
                auth_header,
                custom_headers,
                max_sse_event_size,
            )
            .await;
        match &result {
            Ok(StreamableHttpPostResponse::Accepted) => {
                self.recorder.finish(index, Some("accepted"), None, None)
            }
            Ok(StreamableHttpPostResponse::Json(_, session)) => {
                self.recorder
                    .finish(index, Some("json"), session.as_deref(), None)
            }
            Ok(StreamableHttpPostResponse::Sse(_, session)) => {
                self.recorder
                    .finish(index, Some("sse"), session.as_deref(), None)
            }
            Ok(_) => self.recorder.finish(index, Some("unknown"), None, None),
            Err(error) => self
                .recorder
                .finish(index, None, None, Some(&error.to_string())),
        }
        result
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let index = self
            .recorder
            .record_request("DELETE", &uri, &custom_headers, None);
        let result = <reqwest::Client as StreamableHttpClient>::delete_session(
            &self.client,
            uri,
            session_id,
            auth_header,
            custom_headers,
        )
        .await;
        match &result {
            Ok(()) => self.recorder.finish(index, Some("empty"), None, None),
            Err(error) => self
                .recorder
                .finish(index, None, None, Some(&error.to_string())),
        }
        result
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        let index = self
            .recorder
            .record_request("GET", &uri, &custom_headers, None);
        let result = <reqwest::Client as StreamableHttpClient>::get_stream(
            &self.client,
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
        )
        .await;
        match &result {
            Ok(_) => self.recorder.finish(index, Some("sse"), None, None),
            Err(error) => self
                .recorder
                .finish(index, None, None, Some(&error.to_string())),
        }
        result
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
        let index = self
            .recorder
            .record_request("GET", &uri, &custom_headers, None);
        let result = <reqwest::Client as StreamableHttpClient>::get_stream_with_max_sse_event_size(
            &self.client,
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            max_sse_event_size,
        )
        .await;
        match &result {
            Ok(_) => self.recorder.finish(index, Some("sse"), None, None),
            Err(error) => self
                .recorder
                .finish(index, None, None, Some(&error.to_string())),
        }
        result
    }
}
