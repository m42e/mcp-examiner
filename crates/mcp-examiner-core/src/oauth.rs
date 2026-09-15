use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, AuthorizationRequest,
    AuthorizationSession, CredentialStore, StoredCredentials,
};

use crate::{OAuthConfig, ProtocolError, ServerProfile, TransportConfig};

const MAX_METADATA_BYTES: usize = 1024 * 1024;

pub type OAuthCredentials = StoredCredentials;

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
) -> Result<Option<AuthorizationManager>, ProtocolError> {
    let Some((url, oauth)) = profile_oauth(profile) else {
        return Ok(None);
    };

    let mut manager = AuthorizationManager::new(url)
        .await
        .map_err(|error| ProtocolError::OAuth(error.to_string()))?;
    if let Some(store) = store {
        manager.set_credential_store(CredentialStoreAdapter { store });
    }

    if let Some(metadata_url) = oauth
        .auth_server_metadata_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        manager.set_metadata(fetch_metadata(metadata_url).await?);
    }

    Ok(Some(manager))
}

pub async fn start_oauth_authorization(
    profile: &ServerProfile,
    redirect_uri: impl Into<String>,
    store: Arc<dyn OAuthCredentialStore>,
) -> Result<OAuthAuthorization, ProtocolError> {
    let Some((_, oauth)) = profile_oauth(profile) else {
        return Err(ProtocolError::OAuth(
            "OAuth is only available for HTTP MCP servers".to_owned(),
        ));
    };
    let mut manager = authorization_manager(profile, Some(store.clone()))
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
    let redirect_uri = redirect_uri.into();
    let mut request = AuthorizationRequest::new(redirect_uri)
        .with_client_name("MCP Examiner")
        .with_application_type("native");
    if let Some(client_id) = oauth
        .client_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.with_preregistered_client(client_id);
    } else if let Some(client_id) = stored_client_id {
        request = request.with_preregistered_client(client_id);
    } else if let Some(client_metadata_url) = oauth
        .client_metadata_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
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

fn map_authorization_error(error: AuthError) -> ProtocolError {
    let message = error.to_string();
    if message.contains("Dynamic registration failed: Dynamic client registration not supported") {
        return ProtocolError::OAuth(
            "OAuth server does not support dynamic client registration. Configure a pre-registered clientId, or provide a clientMetadataUrl when the authorization server advertises Client ID Metadata Document support.".to_owned(),
        );
    }
    ProtocolError::OAuth(message)
}

async fn fetch_metadata(url: &str) -> Result<AuthorizationMetadata, ProtocolError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| ProtocolError::OAuth(format!("invalid OAuth metadata URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ProtocolError::OAuth(
            "OAuth metadata URL must be an absolute HTTP(S) URL".to_owned(),
        ));
    }

    let response = reqwest::Client::new()
        .get(parsed)
        .send()
        .await
        .map_err(|error| ProtocolError::OAuth(format!("OAuth metadata request failed: {error}")))?;
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
    serde_json::from_slice(&body)
        .map_err(|error| ProtocolError::OAuth(format!("invalid OAuth metadata: {error}")))
}
