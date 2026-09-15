import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionSnapshot,
  HttpObservation,
  OAuthSnapshot,
  ProtocolEvent,
  ServerProfile,
} from "../../contracts";
import { endpointLabel, transportLabel } from "../../lib/profile";
import { isTauriRuntime } from "../../lib/tauri";

const CLIENT_METADATA_DOCUMENT_MIN_VERSION = "2025-11-25";

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue : null;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[field] === true;
}

function stringArrayField(value: unknown, field: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const fieldValue = (value as Record<string, unknown>)[field];
  if (!Array.isArray(fieldValue)) return [];
  return fieldValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function profileOAuth(profile: ServerProfile) {
  if (profile.transport.type === "http" || profile.transport.type === "sse" || profile.transport.type === "auto") {
    return profile.transport.oauth;
  }
  return null;
}

function supportsClientMetadata(protocol: ServerProfile["protocol"]): boolean {
  switch (protocol.mode) {
    case "legacy":
      return (protocol.version ?? CLIENT_METADATA_DOCUMENT_MIN_VERSION) >= CLIENT_METADATA_DOCUMENT_MIN_VERSION;
    case "auto":
      return (protocol.legacyVersion ?? CLIENT_METADATA_DOCUMENT_MIN_VERSION) >= CLIENT_METADATA_DOCUMENT_MIN_VERSION;
    case "modern":
      return true;
    case "exact":
      return protocol.version >= CLIENT_METADATA_DOCUMENT_MIN_VERSION;
  }
}

function observedAuthorization(
  profile: ServerProfile,
  observations: HttpObservation[],
): OAuthSnapshot | null {
  const protectedResourceObservation = [...observations].reverse().find((observation) =>
    observation.url.includes("oauth-protected-resource") ||
    stringArrayField(observation.responseBody, "authorization_servers").length > 0,
  );
  const authorizationServerObservation = [...observations].reverse().find((observation) =>
    observation.url.includes("oauth-authorization-server") ||
    observation.url.includes("openid-configuration") ||
    stringField(observation.responseBody, "issuer") !== null,
  );
  if (!protectedResourceObservation && !authorizationServerObservation) return null;

  const protectedResource = protectedResourceObservation?.responseBody;
  const authorizationServerMetadata = authorizationServerObservation?.responseBody;
  const oauth = profileOAuth(profile);
  const clientIdMetadataDocumentSupported = booleanField(
    authorizationServerMetadata,
    "client_id_metadata_document_supported",
  );
  const dynamicClientRegistrationSupported =
    stringField(authorizationServerMetadata, "registration_endpoint") !== null;
  const hasConfiguredClientId = Boolean(oauth?.clientId?.trim());
  const hasClientMetadataUrl = Boolean(oauth?.clientMetadataUrl?.trim());
  const protocolSupportsClientMetadata = supportsClientMetadata(profile.protocol);
  const registrationMethod = hasConfiguredClientId
    ? "preRegistered"
    : hasClientMetadataUrl && clientIdMetadataDocumentSupported && protocolSupportsClientMetadata
      ? "clientIdMetadataDocument"
      : dynamicClientRegistrationSupported
        ? "dynamicClientRegistration"
        : "manual";
  const scopesSupported = [
    ...stringArrayField(protectedResource, "scopes_supported"),
    ...stringArrayField(authorizationServerMetadata, "scopes_supported"),
  ].filter((scope, index, scopes) => scopes.indexOf(scope) === index);

  return {
    discoverySource: protectedResourceObservation
      ? "protectedResourceMetadata"
      : oauth?.authServerMetadataUrl
        ? "configuredMetadata"
        : "authorizationServerMetadata",
    authorizationServer:
      stringField(authorizationServerMetadata, "issuer") ??
      stringArrayField(protectedResource, "authorization_servers")[0] ??
      null,
    registrationMethod,
    clientIdMetadataDocumentSupported,
    dynamicClientRegistrationSupported,
    scopesSupported,
  };
}

function mergeAuthorization(
  connection: OAuthSnapshot | null,
  observed: OAuthSnapshot | null,
): OAuthSnapshot | null {
  if (!connection) return observed;
  if (!observed) return connection;
  return {
    ...connection,
    authorizationServer: connection.authorizationServer ?? observed.authorizationServer,
    clientIdMetadataDocumentSupported:
      connection.clientIdMetadataDocumentSupported || observed.clientIdMetadataDocumentSupported,
    dynamicClientRegistrationSupported:
      connection.dynamicClientRegistrationSupported || observed.dynamicClientRegistrationSupported,
    scopesSupported:
      connection.scopesSupported.length > 0 ? connection.scopesSupported : observed.scopesSupported,
  };
}

function discoveryLabel(source: string): string {
  return {
    protectedResourceMetadata: "Protected resource metadata",
    authorizationServerMetadata: "Authorization server metadata",
    configuredMetadata: "Configured metadata URL",
    legacyEndpointFallback: "Legacy endpoint fallback",
  }[source] ?? "Unknown";
}

function registrationLabel(method: string): string {
  return {
    preRegistered: "Pre-registered client",
    clientIdMetadataDocument: "Client ID Metadata Document",
    dynamicClientRegistration: "Dynamic Client Registration",
    manual: "Manual registration required",
  }[method] ?? "Unknown";
}

export function Overview({
  profile,
  connection,
  connectionError,
}: {
  profile: ServerProfile;
  connection: ConnectionSnapshot | null;
  connectionError: string | null;
}) {
  const [events, setEvents] = useState<ProtocolEvent[]>([]);
  const [observations, setObservations] = useState<HttpObservation[]>([]);
  const endpoint = endpointLabel(profile.transport);
  const usesInsecureHttp = profile.transport.type !== "stdio" && endpoint.startsWith("http://");

  useEffect(() => {
    if (!isTauriRuntime()) return;
    Promise.all([
      invoke<ProtocolEvent[]>("session_events", {
        request: { serverName: profile.name },
      }).catch(() => []),
      invoke<HttpObservation[]>("http_observations", {
        request: { serverName: profile.name },
      }).catch(() => []),
    ]).then(([nextEvents, nextObservations]) => {
      setEvents(nextEvents);
      setObservations(nextObservations);
    });
  }, [profile.name, connection?.protocolVersion, connectionError]);

  const authorization = mergeAuthorization(
    connection?.authorization ?? null,
    observedAuthorization(profile, observations),
  );

  return (
    <div className="overview-grid">
      <div className="overview-panel">
        <div className="summary-groups">
          <div className="summary-group server-summary">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Negotiation</span>
                <h2>Server identity</h2>
              </div>
              <span className="source-pill">{connection ? "Connected" : "Not connected"}</span>
            </div>
            {connection ? (
              <dl className="definition-grid">
                <div>
                  <dt>Implementation</dt>
                  <dd>{stringField(connection.serverInfo, "title") ?? stringField(connection.serverInfo, "name") ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>Server version</dt>
                  <dd>{stringField(connection.serverInfo, "version") ?? "Not reported"}</dd>
                </div>
                <div className="definition-wide">
                  <dt>Negotiated MCP protocol</dt>
                  <dd className="mono">{connection.protocolVersion}</dd>
                </div>
              </dl>
            ) : (
              <div className="server-summary-empty">Connect to inspect the server handshake.</div>
            )}
          </div>

          <div className="summary-group connection-summary">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Configuration</span>
                <h2>Connection profile</h2>
              </div>
              <span className="source-pill">{profile.source.kind}</span>
            </div>
            <dl className="definition-grid">
              <div className="definition-wide">
                <dt>Transport</dt>
                <dd>{transportLabel(profile.transport)}</dd>
              </div>
              <div className="definition-wide">
                <dt>Endpoint</dt>
                <dd className="mono">
                  {usesInsecureHttp ? (
                    <>
                      <span className="endpoint-insecure-scheme" title="This endpoint uses unencrypted HTTP. HTTPS is recommended when available.">http://</span>
                      {endpoint.slice("http://".length)}
                    </>
                  ) : endpoint}
                </dd>
              </div>
            </dl>
          </div>

          <div className="summary-group authorization-summary">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Authorization</span>
                <h2>OAuth discovery</h2>
              </div>
              <span className="source-pill">{authorization ? "Detected" : "Not observed"}</span>
            </div>
            {authorization ? (
              <dl className="definition-grid">
                <div>
                  <dt>Metadata source</dt>
                  <dd>{discoveryLabel(authorization.discoverySource)}</dd>
                </div>
                <div>
                  <dt>Client registration</dt>
                  <dd>{registrationLabel(authorization.registrationMethod)}</dd>
                </div>
                <div className="definition-wide">
                  <dt>Authorization server</dt>
                  <dd className="mono">{authorization.authorizationServer ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>Client ID metadata</dt>
                  <dd>{authorization.clientIdMetadataDocumentSupported ? "Supported" : "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Dynamic registration</dt>
                  <dd>{authorization.dynamicClientRegistrationSupported ? "Supported" : "Unavailable"}</dd>
                </div>
                <div className="definition-wide">
                  <dt>Advertised scopes</dt>
                  <dd>{authorization.scopesSupported.length > 0 ? authorization.scopesSupported.join(" ") : "Not advertised"}</dd>
                </div>
              </dl>
            ) : (
              <div className="server-summary-empty">No OAuth discovery was observed for this connection.</div>
            )}
          </div>
        </div>

        <div className="activity-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Session</span>
              <h2>Protocol activity</h2>
            </div>
            <span className="event-count">{events.length} events</span>
          </div>
          {events.length > 0 ? (
            <div className="overview-events">
              {events.slice(-6).reverse().map((event) => (
                <div key={event.sequence}>
                  <span>#{event.sequence}</span>
                  <b className={`direction-${event.direction}`}>{event.direction}</b>
                  <code>{event.method}</code>
                  <small>{event.elapsedMs} ms</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="activity-empty">
              <Activity size={22} />
              <span>{connection ? "Waiting for session events" : "No retained session traffic"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
