# MCP Examiner

A native workbench for inspecting and testing Model Context Protocol servers. MCP Examiner is being built as a Tauri 2 desktop application with a shared Rust engine and headless CLI.

## Development

```bash
npm install
npm run tauri dev
```

Plain Cargo commands use the embedded frontend by default:

```bash
cargo run -p mcp-examiner-app
```

Use `--no-default-features` when you want the direct Cargo command to start and use Vite for hot reload:

```bash
cargo run --no-default-features -p mcp-examiner-app
```

Normal Cargo builds enable the `custom-protocol` feature by default. The crate's build script then rebuilds the frontend before compiling Tauri, so direct Cargo commands include the current UI:

```bash
cargo build -p mcp-examiner-app
cargo run -p mcp-examiner-app
```

Build and launch the macOS release bundle through the Tauri CLI:

```bash
npm run tauri build
open "target/release/bundle/macos/MCP Examiner.app"
```

Run the frontend by itself at `http://localhost:1420` with `npm run dev`. Rust-backed actions such as configuration import require the Tauri runtime.

## OAuth login

Remote HTTP profiles can use MCP OAuth authorization with an optional `oauth` block:

```json
{
	"type": "http",
	"url": "https://example.com/mcp",
	"oauth": {
		"clientId": "registered-client-id",
		"clientMetadataUrl": "https://example.com/client-metadata.json",
		"scopes": "tools.read"
	}
}
```

The desktop app follows the MCP client-registration order: a configured `clientId`, a configured `clientMetadataUrl` when the selected MCP revision supports Client ID Metadata Documents and the authorization server advertises support, then dynamic registration as a backwards-compatible fallback. Client ID Metadata Documents are available from the `2025-11-25` revision onward; the older `2025-03-26` and `2025-06-18` revisions use Dynamic Client Registration. A client metadata document must be hosted at a public HTTPS URL and its JSON must use that exact URL as `client_id`, alongside `client_name` and `redirect_uris`. The app discovers the authorization server, uses a PKCE loopback callback, and opens the system browser for login. Access and refresh credentials are stored in the OS keychain, scoped to the configured server endpoint, and are never written to MCP configuration files or reports. `callbackPort` can be set when a pre-registered client requires a fixed loopback port; `authServerMetadataUrl` can be used when metadata discovery needs an explicit URL.

MCP Examiner includes a repository-hosted public client metadata document at `https://raw.githubusercontent.com/m42e/mcp-examiner/main/public/mcp-examiner-client-metadata.json`. To use it, configure `clientMetadataUrl` with that exact URL and set `callbackPort` to `43123`; the hosted document registers `http://127.0.0.1:43123/oauth/callback`.

## CLI

Normalize an existing client configuration:

```bash
npm run cli -- import-config .vscode/mcp.json
```

CLI output preserves the normalized structure but replaces credential-bearing values and secret input defaults with `[REDACTED]`.

List the supported protocol revisions:

```bash
npm run cli -- versions
```

Validate and run a test set:

```bash
npm run cli -- validate tests/fixtures/basic.mcp-test.yaml
npm run cli -- run tests/fixtures/basic.mcp-test.yaml \
	--config tests/fixtures/configs/runner.mcp.json \
	--server fixture \
	--workspace-folder . \
	--report mcp-examiner-report.html
```

The runner writes the requested HTML path and a YAML report with the same basename next to it. The Tests tab provides an editable HTML target path and displays both absolute saved paths after writing the pair.

See [docs/suite-format.md](docs/suite-format.md) for the schema-compatible format and assertion semantics.

## Verification

```bash
npm run check
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

The Playwright checks exercise the workbench at desktop and narrow viewport sizes. Browser-only runs intentionally do not invoke privileged Rust commands.

## GitHub Actions

Pull requests and pushes to `main` run the frontend, Rust, and Playwright checks through `npm run check` on Linux, macOS, and Windows. The release workflow builds native Tauri bundles for Linux x86_64 and arm64, macOS Apple Silicon, and Windows x86_64 for version tags or an explicitly selected tag.

To publish a release, update the versions in `package.json`, `Cargo.toml`, and `src-tauri/tauri.conf.json`, then push a tag with the matching `v` prefix, for example `v0.1.0`. The tagged build creates a GitHub release and attaches the platform bundles automatically.

The macOS release follows the same staged signing model as [`pw-env`](https://github.com/m42e/pw-env/). Create a `Developer ID Application` certificate, export it as a password-protected `.p12`, and configure these GitHub Actions secrets:

- `APPLE_CERT_BASE64` (base64-encoded `.p12`; `openssl base64 -A -in certificate.p12 -out certificate-base64.txt`)
- `APPLE_CERT_PASSWORD`
- `APPLE_SIGNING_IDENTITY`

Notarization is optional and requires all three of these secrets together:

- `APPLE_ID`
- `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

The helper below prepares the signing secrets and can upload them with the GitHub CLI. Omit the three notarization flags when signing only:

```bash
./scripts/setup-apple-signing-secrets.sh \
	--cert ~/Certificates/developer-id-application.p12 \
	--cert-password 'export-password' \
	--identity 'Developer ID Application: Example Corp (TEAMID1234)' \
	--apple-id 'developer@example.com' \
	--app-password 'abcd-efgh-ijkl-mnop' \
	--team-id 'TEAMID1234' \
	--repo 'OWNER/REPOSITORY' \
	--set-gh-secrets
```

When signing secrets are absent, the release remains publishable but its macOS DMG is unsigned. When signing secrets are present, the workflow imports the certificate into a temporary keychain, signs the Tauri application, and verifies it before publishing. When notarization secrets are also present, the DMG is submitted without waiting; the scheduled `finalize-notarization.yml` workflow polls Apple, staples accepted tickets, validates the DMG, and replaces the release asset in place. Existing unsigned downloads must be replaced by publishing a new release after configuring the secrets.

