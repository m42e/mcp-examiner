use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, AuthorizationMetadataSource,
    AuthorizationRequest, AuthorizationSession, CredentialStore, OAuthHttpClient,
    StoredCredentials,
};
use serde::{Deserialize, Serialize};

use crate::{
    OAuthConfig, ProtocolError, ProtocolSelection, ServerProfile, TransportConfig,
    TransportRecorder, transport::ObservableOAuthHttpClient,
};

const MAX_METADATA_BYTES: usize = 1024 * 1024;
const CLIENT_METADATA_DOCUMENT_MIN_VERSION: &str = "2025-11-25";
const NATIVE_APPLICATION_TYPE_MIN_VERSION: &str = "2026-07-28";

pub type OAuthCredentials = StoredCredentials;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OAuthDiscoverySource {
    ProtectedResourceMetadata,
    AuthorizationServerMetadata,
    ConfiguredMetadata,
    LegacyEndpointFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OAuthRegistrationMethod {
    PreRegistered,
    ClientIdMetadataDocument,
    DynamicClientRegistration,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthRegistrationPreference {
    Automatic,
    DynamicClientRegistration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSnapshot {
    pub discovery_source: OAuthDiscoverySource,
    pub authorization_server: Option<String>,
    pub registration_method: OAuthRegistrationMethod,
    pub client_id_metadata_document_supported: bool,
    pub dynamic_client_registration_supported: bool,
    pub scopes_supported: Vec<String>,
}

#[async_trait]
pub trait OAuthCredentialStore: Send + Sync {
    async fn load(&self) -> Result<Option<OAuthCredentials>, String>;

    async fn save(&self, credentials: OAuthCredentials) -> Result<(), String>;

    async fn clear(&self) -> Result<(), String>;
}

struct CredentialStoreAdapter {
    store: Arc<dyn OAuthCredentialStore>,
}

#[async_trait]
impl CredentialStore for CredentialStoreAdapter {
    async fn load(&self) -> Result<Option<OAuthCredentials>, AuthError> {
        self.store.load().await.map_err(AuthError::InternalError)
    }

    async fn save(&self, credentials: OAuthCredentials) -> Result<(), AuthError> {
        self.store
            .save(credentials)
            .await
            .map_err(AuthError::InternalError)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.store.clear().await.map_err(AuthError::InternalError)
    }
}

pub struct OAuthAuthorization {
    session: AuthorizationSession,
}

impl OAuthAuthorization {
    pub fn authorization_url(&self) -> &str {
        self.session.get_authorization_url()
    }

    pub async fn complete(self, callback_url: &str) -> Result<(), ProtocolError> {
        self.session
            .handle_callback_url(callback_url)
            .await
            .map(|_| ())
            .map_err(|error| ProtocolError::OAuth(error.to_string()))
    }
}

pub(crate) fn profile_oauth(profile: &ServerProfile) -> Option<(&str, OAuthConfig)> {
    match &profile.transport {
        TransportConfig::Http { url, oauth, .. }
        | TransportConfig::Sse { url, oauth, .. }
        | TransportConfig::Auto { url, oauth, .. } => {
            Some((url.as_str(), oauth.clone().unwrap_or_default()))
        }
        TransportConfig::Stdio { .. } | TransportConfig::Websocket { .. } => None,
    }
}

pub(crate) async fn authorization_manager(
    profile: &ServerProfile,
    store: Option<Arc<dyn OAuthCredentialStore>>,
    recorder: Option<TransportRecorder>,
) -> Result<Option<AuthorizationManager>, ProtocolError> {
    let Some((url, oauth)) = profile_oauth(profile) else {
        return Ok(None);
    };

    let oauth_http_client = recorder.as_ref().map(|recorder| {
        Arc::new(ObservableOAuthHttpClient::new(recorder.clone())) as Arc<dyn OAuthHttpClient>
    });
    let mut manager = match oauth_http_client {
        Some(client) => AuthorizationManager::new_with_oauth_http_client(url, client).await,
        None => AuthorizationManager::new(url).await,
    }
    .map_err(|error| ProtocolError::OAuth(error.to_string()))?;
    if let Some(store) = store {
        manager.set_credential_store(CredentialStoreAdapter { store });
    }

    if let Some(metadata_url) = oauth
        .auth_server_metadata_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        manager.set_metadata(fetch_metadata(metadata_url, recorder.as_ref()).await?);
    }

    Ok(Some(manager))
}

pub(crate) async fn authorization_snapshot(
    profile: &ServerProfile,
    store: Option<Arc<dyn OAuthCredentialStore>>,
    recorder: Option<TransportRecorder>,
) -> Result<Option<OAuthSnapshot>, ProtocolError> {
    let Some((url, oauth)) = profile_oauth(profile) else {
        return Ok(None);
    };

    let oauth_http_client = recorder.as_ref().map(|recorder| {
        Arc::new(ObservableOAuthHttpClient::new(recorder.clone())) as Arc<dyn OAuthHttpClient>
    });
    let manager = match oauth_http_client {
        Some(client) => AuthorizationManager::new_with_oauth_http_client(url, client).await,
        None => AuthorizationManager::new(url).await,
    }
    .map_err(|error| ProtocolError::OAuth(error.to_string()))?;

    let (metadata, discovery_source) = if let Some(metadata_url) = oauth
        .auth_server_metadata_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        (
            fetch_metadata(metadata_url, recorder.as_ref()).await?,
            OAuthDiscoverySource::ConfiguredMetadata,
        )
    } else {
        let resolution = manager
            .resolve_metadata()
            .await
            .map_err(|error| ProtocolError::OAuth(error.to_string()))?;
        (
            resolution.metadata,
            match resolution.source {
                AuthorizationMetadataSource::ProtectedResourceMetadata => {
                    OAuthDiscoverySource::ProtectedResourceMetadata
                }
                AuthorizationMetadataSource::AuthorizationServerMetadata => {
                    OAuthDiscoverySource::AuthorizationServerMetadata
                }
                AuthorizationMetadataSource::LegacyEndpointFallback => {
                    OAuthDiscoverySource::LegacyEndpointFallback
                }
                _ => OAuthDiscoverySource::LegacyEndpointFallback,
            },
        )
    };

    let stored_client_id = match store {
        Some(store) => store
            .load()
            .await
            .map_err(ProtocolError::OAuth)?
            .map(|credentials| credentials.client_id),
        None => None,
    };
    let has_configured_client_id = oauth
        .client_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_client_metadata_url = oauth
        .client_metadata_url
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let client_id_metadata_document_supported = metadata
        .additional_fields
        .get("client_id_metadata_document_supported")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let dynamic_client_registration_supported = metadata.registration_endpoint.is_some();
    let protocol_supports_client_metadata =
        protocol_supports_version(&profile.protocol, CLIENT_METADATA_DOCUMENT_MIN_VERSION);
    let registration_method = registration_method(
        &oauth,
        stored_client_id.as_deref(),
        has_configured_client_id,
        has_client_metadata_url,
        client_id_metadata_document_supported,
        protocol_supports_client_metadata,
        dynamic_client_registration_supported,
    );

    Ok(Some(OAuthSnapshot {
        discovery_source,
        authorization_server: metadata.issuer,
        registration_method,
        client_id_metadata_document_supported,
        dynamic_client_registration_supported,
        scopes_supported: metadata.scopes_supported.unwrap_or_default(),
    }))
}

fn registration_method(
    oauth: &OAuthConfig,
    stored_client_id: Option<&str>,
    has_configured_client_id: bool,
    has_client_metadata_url: bool,
    client_id_metadata_document_supported: bool,
    protocol_supports_client_metadata: bool,
    dynamic_client_registration_supported: bool,
) -> OAuthRegistrationMethod {
    if has_configured_client_id {
        return OAuthRegistrationMethod::PreRegistered;
    }

    let stored_client_id_is_metadata_url = stored_client_id
        .zip(oauth.client_metadata_url.as_deref())
        .is_some_and(|(stored_client_id, metadata_url)| {
            stored_client_id.trim() == metadata_url.trim()
        });
    if stored_client_id_is_metadata_url
        && client_id_metadata_document_supported
        && protocol_supports_client_metadata
    {
        return OAuthRegistrationMethod::ClientIdMetadataDocument;
    }
    if stored_client_id.is_some() || dynamic_client_registration_supported {
        return OAuthRegistrationMethod::DynamicClientRegistration;
    }
    if has_client_metadata_url
        && client_id_metadata_document_supported
        && protocol_supports_client_metadata
    {
        return OAuthRegistrationMethod::ClientIdMetadataDocument;
    }
    OAuthRegistrationMethod::Manual
}

fn client_metadata_url_for_preference(
    oauth: &OAuthConfig,
    preference: OAuthRegistrationPreference,
    protocol_supports_client_metadata: bool,
) -> Option<&str> {
    if preference == OAuthRegistrationPreference::DynamicClientRegistration
        || !protocol_supports_client_metadata
    {
        return None;
    }
    oauth
        .client_metadata_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
}

pub async fn start_oauth_authorization(
    profile: &ServerProfile,
    redirect_uri: impl Into<String>,
    store: Arc<dyn OAuthCredentialStore>,
) -> Result<OAuthAuthorization, ProtocolError> {
    start_oauth_authorization_with_recorder(profile, redirect_uri, store, None).await
}

pub async fn start_oauth_authorization_with_recorder(
    profile: &ServerProfile,
    redirect_uri: impl Into<String>,
    store: Arc<dyn OAuthCredentialStore>,
    recorder: Option<TransportRecorder>,
) -> Result<OAuthAuthorization, ProtocolError> {
    start_oauth_authorization_with_recorder_and_preference(
        profile,
        redirect_uri,
        store,
        recorder,
        OAuthRegistrationPreference::Automatic,
    )
    .await
}

pub async fn start_oauth_authorization_with_recorder_and_preference(
    profile: &ServerProfile,
    redirect_uri: impl Into<String>,
    store: Arc<dyn OAuthCredentialStore>,
    recorder: Option<TransportRecorder>,
    preference: OAuthRegistrationPreference,
) -> Result<OAuthAuthorization, ProtocolError> {
    let Some((_, oauth)) = profile_oauth(profile) else {
        return Err(ProtocolError::OAuth(
            "OAuth is only available for HTTP MCP servers".to_owned(),
        ));
    };
    let mut manager = authorization_manager(profile, Some(store.clone()), recorder)
        .await?
        .ok_or_else(|| ProtocolError::OAuth("OAuth configuration is missing".to_owned()))?;

    if oauth
        .auth_server_metadata_url
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        let resolution = manager
            .resolve_metadata()
            .await
            .map_err(|error| ProtocolError::OAuth(error.to_string()))?;
        manager.set_metadata(resolution.metadata);
    }

    let stored_client_id = store
        .load()
        .await
        .map_err(ProtocolError::OAuth)?
        .map(|credentials| credentials.client_id);
    let protocol_supports_client_metadata =
        protocol_supports_version(&profile.protocol, CLIENT_METADATA_DOCUMENT_MIN_VERSION);
    let redirect_uri = redirect_uri.into();
    let mut request = AuthorizationRequest::new(redirect_uri).with_client_name("MCP Examiner");
    if protocol_supports_version(&profile.protocol, NATIVE_APPLICATION_TYPE_MIN_VERSION) {
        request = request.with_application_type("native");
    }
    if let Some(client_id) = oauth
        .client_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.with_preregistered_client(client_id);
    } else if let Some(client_id) = stored_client_id {
        request = request.with_preregistered_client(client_id);
    } else if let Some(client_metadata_url) =
        client_metadata_url_for_preference(&oauth, preference, protocol_supports_client_metadata)
    {
        request = request.with_client_metadata_url(client_metadata_url);
    }
    if let Some(scopes) = oauth
        .scopes
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.with_scopes(scopes.split_whitespace());
    }

    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, error)| map_authorization_error(error))?;
    Ok(OAuthAuthorization { session })
}

fn protocol_supports_version(selection: &ProtocolSelection, minimum_version: &str) -> bool {
    configured_protocol_version(selection) >= minimum_version
}

fn configured_protocol_version(selection: &ProtocolSelection) -> &str {
    match selection {
        ProtocolSelection::Legacy { version }
        | ProtocolSelection::Auto {
            legacy_version: version,
        } => version
            .as_deref()
            .unwrap_or(CLIENT_METADATA_DOCUMENT_MIN_VERSION),
        ProtocolSelection::Modern => NATIVE_APPLICATION_TYPE_MIN_VERSION,
        ProtocolSelection::Exact { version } => version,
    }
}

fn map_authorization_error(error: AuthError) -> ProtocolError {
    let message = error.to_string();
    if message.contains("Dynamic registration failed: Dynamic client registration not supported") {
        return ProtocolError::OAuth(
            "OAuth server does not support dynamic client registration. Configure a pre-registered clientId, or provide a clientMetadataUrl when the authorization server advertises Client ID Metadata Document support.".to_owned(),
        );
    }
    ProtocolError::OAuth(message)
}

async fn fetch_metadata(
    url: &str,
    recorder: Option<&TransportRecorder>,
) -> Result<AuthorizationMetadata, ProtocolError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| ProtocolError::OAuth(format!("invalid OAuth metadata URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ProtocolError::OAuth(
            "OAuth metadata URL must be an absolute HTTP(S) URL".to_owned(),
        ));
    }

    let body = if let Some(recorder) = recorder {
        let index =
            recorder.record_bytes_request("GET", parsed.as_str(), &http::HeaderMap::new(), &[]);
        let response = match reqwest::Client::new().get(parsed).send().await {
            Ok(response) => response,
            Err(error) => {
                recorder.finish(index, None, None, None, Some(&error.to_string()));
                return Err(ProtocolError::OAuth(format!(
                    "OAuth metadata request failed: {error}"
                )));
            }
        };
        let status = response.status();
        let mut body = Vec::new();
        let mut body_stream = response.bytes_stream();
        while let Some(chunk) = body_stream.next().await {
            let chunk = chunk.map_err(|error| {
                recorder.finish(index, None, None, None, Some(&error.to_string()));
                ProtocolError::OAuth(format!("failed to read OAuth metadata response: {error}"))
            })?;
            if chunk.len() > MAX_METADATA_BYTES.saturating_sub(body.len()) {
                let error = format!("OAuth metadata response exceeds {MAX_METADATA_BYTES} bytes");
                recorder.finish(index, None, None, None, Some(&error));
                return Err(ProtocolError::OAuth(error));
            }
            body.extend_from_slice(&chunk);
        }
        let response_body = serde_json::from_slice(&body).ok();
        let response_kind = format!("oauth {status}");
        recorder.finish(index, Some(&response_kind), response_body, None, None);
        if !status.is_success() {
            return Err(ProtocolError::OAuth(format!(
                "OAuth metadata request returned HTTP {status}"
            )));
        }
        body
    } else {
        let response = reqwest::Client::new()
            .get(parsed)
            .send()
            .await
            .map_err(|error| {
                ProtocolError::OAuth(format!("OAuth metadata request failed: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(ProtocolError::OAuth(format!(
                "OAuth metadata request returned HTTP {}",
                response.status()
            )));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                ProtocolError::OAuth(format!("failed to read OAuth metadata response: {error}"))
            })?;
            if chunk.len() > MAX_METADATA_BYTES.saturating_sub(body.len()) {
                return Err(ProtocolError::OAuth(format!(
                    "OAuth metadata response exceeds {MAX_METADATA_BYTES} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        body
    };
    if body.len() > MAX_METADATA_BYTES {
        return Err(ProtocolError::OAuth(format!(
            "OAuth metadata response exceeds {MAX_METADATA_BYTES} bytes"
        )));
    }
    serde_json::from_slice(&body)
        .map_err(|error| ProtocolError::OAuth(format!("invalid OAuth metadata: {error}")))
}

#[cfg(test)]
mod tests {
    use super::{
        CLIENT_METADATA_DOCUMENT_MIN_VERSION, NATIVE_APPLICATION_TYPE_MIN_VERSION,
        OAuthRegistrationMethod, OAuthRegistrationPreference, client_metadata_url_for_preference,
        protocol_supports_version, registration_method,
    };
    use crate::{OAuthConfig, ProtocolSelection};

    #[test]
    fn stored_dynamic_client_is_not_reported_as_pre_registered() {
        let method = registration_method(
            &OAuthConfig::default(),
            Some("dynamic-client"),
            false,
            false,
            true,
            true,
            true,
        );

        assert_eq!(method, OAuthRegistrationMethod::DynamicClientRegistration);
    }

    #[test]
    fn client_metadata_documents_require_protocol_support() {
        let method = registration_method(
            &OAuthConfig {
                client_metadata_url: Some("https://example.com/client-metadata.json".to_owned()),
                ..OAuthConfig::default()
            },
            None,
            false,
            true,
            true,
            false,
            true,
        );

        assert_eq!(method, OAuthRegistrationMethod::DynamicClientRegistration);
    }

    #[test]
    fn dynamic_registration_preference_ignores_configured_client_metadata_url() {
        let oauth = OAuthConfig {
            client_metadata_url: Some("https://example.com/client-metadata.json".to_owned()),
            ..OAuthConfig::default()
        };

        assert_eq!(
            client_metadata_url_for_preference(
                &oauth,
                OAuthRegistrationPreference::Automatic,
                true,
            ),
            Some("https://example.com/client-metadata.json")
        );
        assert_eq!(
            client_metadata_url_for_preference(
                &oauth,
                OAuthRegistrationPreference::DynamicClientRegistration,
                true,
            ),
            None
        );
    }

    #[test]
    fn legacy_protocols_do_not_use_newer_oauth_registration_features() {
        let selection = ProtocolSelection::Exact {
            version: "2025-06-18".to_owned(),
        };

        assert!(!protocol_supports_version(
            &selection,
            CLIENT_METADATA_DOCUMENT_MIN_VERSION
        ));
        assert!(!protocol_supports_version(
            &selection,
            NATIVE_APPLICATION_TYPE_MIN_VERSION
        ));
    }

    #[test]
    fn default_legacy_protocol_supports_client_metadata_but_not_application_type() {
        let selection = ProtocolSelection::Legacy { version: None };

        assert!(protocol_supports_version(
            &selection,
            CLIENT_METADATA_DOCUMENT_MIN_VERSION
        ));
        assert!(!protocol_supports_version(
            &selection,
            NATIVE_APPLICATION_TYPE_MIN_VERSION
        ));
    }

    #[test]
    fn modern_protocol_supports_both_registration_features() {
        let selection = ProtocolSelection::Modern;

        assert!(protocol_supports_version(
            &selection,
            CLIENT_METADATA_DOCUMENT_MIN_VERSION
        ));
        assert!(protocol_supports_version(
            &selection,
            NATIVE_APPLICATION_TYPE_MIN_VERSION
        ));
    }

    #[test]
    fn automatic_protocol_uses_its_legacy_floor() {
        let selection = ProtocolSelection::Auto {
            legacy_version: Some("2025-06-18".to_owned()),
        };

        assert!(!protocol_supports_version(
            &selection,
            CLIENT_METADATA_DOCUMENT_MIN_VERSION
        ));
    }
}
