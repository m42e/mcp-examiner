# OAuth and secret handling

Remote HTTP profiles can use MCP OAuth authorization. OAuth settings are optional and belong to the remote profile rather than the test document.

## Configure OAuth

The normalized profile shape is:

```json
{
  "type": "http",
  "url": "https://example.com/mcp",
  "oauth": {
    "clientId": "registered-client-id",
    "clientMetadataUrl": "https://example.com/client-metadata.json",
    "scopes": "tools.read",
    "callbackPort": 43123,
    "authServerMetadataUrl": "https://example.com/.well-known/oauth-authorization-server"
  }
}
```

The structured server editor exposes these fields for HTTP, SSE, and auto-detected profiles. `callbackPort` is useful when a pre-registered client requires a fixed loopback callback. `authServerMetadataUrl` overrides discovery when an authorization server does not expose metadata at the expected location.

## Registration order

MCP Examiner follows this order:

1. Use a configured `clientId` as a pre-registered client.
2. Use a configured `clientMetadataUrl` when the selected MCP revision supports Client ID Metadata Documents and the authorization server advertises support.
3. Fall back to Dynamic Client Registration when a registration endpoint is advertised.

Client ID Metadata Documents are available from MCP revision `2025-11-25` onward. The older `2025-03-26` and `2025-06-18` revisions use Dynamic Client Registration. A metadata document must be hosted at a public HTTPS URL, and its JSON must use the exact document URL as `client_id` alongside `client_name` and `redirect_uris`.

The repository includes a public metadata document at:

```text
https://raw.githubusercontent.com/m42e/mcp-examiner/main/public/mcp-examiner-client-metadata.json
```

That document registers `http://127.0.0.1:43123/oauth/callback`, so configure the matching `clientMetadataUrl` and `callbackPort` when using it.

## Login flow

When a server responds that authorization is required:

1. Connect discovers protected-resource and authorization-server metadata.
2. The app exposes **Log in** in the server header.
3. The system browser opens the authorization page.
4. MCP Examiner uses PKCE and a loopback callback on `127.0.0.1`.
5. After the callback, the app retries the MCP connection with the stored credentials.

If a Client ID Metadata Document attempt is cancelled and the server advertises Dynamic Client Registration, the header offers **Retry with DCR**.

## Credential storage

Access and refresh credentials are stored in the operating system keychain, scoped to the configured server endpoint. Managed environment variables and headers use the same secure storage path. The configuration file and generated reports contain references or redacted values, never the resolved secret.

The **Manage secrets** action lists stored secret identifiers and OAuth credential summaries without displaying secret values. A connection can prompt for missing values and, when requested, persist them to the keychain for later use.

## Redaction boundary

Secret-bearing values are redacted before they enter connection errors, protocol events, HTTP observations, CLI import output, HTML reports, or YAML reports. Treat endpoint URLs, server responses, and tool results as potentially sensitive even though credential values are filtered.