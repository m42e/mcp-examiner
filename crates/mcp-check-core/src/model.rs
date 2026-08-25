use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FORMAT_VERSION: u32 = 1;

pub const PUBLISHED_PROTOCOL_VERSIONS: &[&str] = &[
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSourceKind {
    Auto,
    VsCode,
    Claude,
    Inspector,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProtocolSelection {
    Legacy { version: Option<String> },
    Auto { legacy_version: Option<String> },
    Modern,
    Exact { version: String },
}

impl Default for ProtocolSelection {
    fn default() -> Self {
        Self::Legacy {
            version: Some("2025-11-25".to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
    pub client_id: Option<String>,
    pub callback_port: Option<u16>,
    pub scopes: Option<String>,
    pub auth_server_metadata_url: Option<String>,
    pub enterprise_managed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, Value>,
        env_file: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        oauth: Option<OAuthConfig>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        oauth: Option<OAuthConfig>,
    },
    #[serde(rename = "auto")]
    Auto {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        oauth: Option<OAuthConfig>,
    },
    Websocket {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub format_version: u32,
    pub name: String,
    pub transport: TransportConfig,
    pub protocol: ProtocolSelection,
    pub source: ProfileSource,
    pub timeout_ms: Option<u64>,
    pub trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSource {
    pub kind: ConfigSourceKind,
    pub path: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDiagnostic {
    pub level: DiagnosticLevel,
    pub server: Option<String>,
    pub field: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub format_version: u32,
    pub source_kind: ConfigSourceKind,
    pub profiles: Vec<ServerProfile>,
    pub inputs: Vec<ConfigInputDefinition>,
    pub diagnostics: Vec<ImportDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigInputKind {
    Prompt,
    Pick,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInputOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInputDefinition {
    pub id: String,
    pub kind: ConfigInputKind,
    pub description: String,
    pub secret: bool,
    pub default_value: Option<String>,
    pub options: Vec<ConfigInputOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub format_version: u32,
    pub protocol_versions: Vec<String>,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: "MCP Check".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            format_version: FORMAT_VERSION,
            protocol_versions: PUBLISHED_PROTOCOL_VERSIONS
                .iter()
                .map(|version| (*version).to_owned())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_enum_fields_for_frontend_contracts() {
        let protocol = serde_json::to_value(ProtocolSelection::Auto {
            legacy_version: Some("2025-11-25".to_owned()),
        })
        .unwrap();
        assert_eq!(protocol["legacyVersion"], "2025-11-25");
        assert!(protocol.get("legacy_version").is_none());

        let transport = serde_json::to_value(TransportConfig::Stdio {
            command: "server".to_owned(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            env_file: Some(".env".to_owned()),
        })
        .unwrap();
        assert_eq!(transport["envFile"], ".env");
        assert!(transport.get("env_file").is_none());
    }
}
