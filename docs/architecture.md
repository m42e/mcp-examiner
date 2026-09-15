# Architecture and development

MCP Examiner is a Cargo workspace containing a shared Rust engine, a headless CLI, and a Tauri desktop shell around the React frontend.

## Repository map

| Path | Responsibility |
| --- | --- |
| `crates/mcp-examiner-core` | Profiles, config import, resolution, OAuth, transports, sessions, redaction, test execution, and reports. |
| `crates/mcp-examiner-cli` | `import-config`, `versions`, `validate`, and `run` commands over the core engine. |
| `src-tauri` | Tauri commands, native file dialogs, keychain integration, OAuth browser/callback plumbing, and application packaging. |
| `src/` | React workbench, profile editor, inspector panels, test editor, and styling. |
| `tests/fixtures` | Dependency-free MCP servers, client configs, and test sets used by automated checks. |
| `tests/ui` | Playwright coverage for layout, import, editor, OAuth states, and the main workbench. |
| `docs/` | User documentation and the schema/test-set reference. |

The Rust engine uses the official `rmcp` client for standard I/O and Streamable HTTP sessions. Tauri exposes narrow commands to the UI; the frontend does not own transport or credential logic.

## Data flow

```text
MCP client JSON
        |
        v
  config import and normalization
        |
        v
  ServerProfile + resolved inputs
        |
        +--> interactive SessionManager --> connection snapshot --> inspector tabs
        |
        +--> test runner on a fresh session --> redacted result --> HTML + YAML reports
```

Profiles use camelCase at the UI/Tauri boundary. Resolution combines workspace values, process environment, environment files, and explicit inputs before a process starts or a remote request is sent. Explicit profile values take precedence over environment-file values.

## Run the checks

The standard full check is:

```bash
npm run check
```

It builds the frontend, runs all workspace Rust tests, and runs the Playwright UI suite. The focused checks are:

```bash
npm run build
cargo test --workspace
npm run test:ui
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

The browser-only UI tests intentionally avoid privileged Rust commands. Live MCP fixtures are small Node scripts under `tests/fixtures/servers`, which keeps the tests deterministic and dependency-free.

## Release builds

The Tauri release workflow builds native bundles for Linux x86_64 and arm64, macOS Apple Silicon, and Windows x86_64 for version tags or an explicitly selected tag. Before publishing a release, update the versions in `package.json`, `Cargo.toml`, and `src-tauri/tauri.conf.json`, then push a matching `v` tag such as `v0.1.0`.

Build locally with:

```bash
npm run tauri build
```

macOS signing is staged. `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`, and `APPLE_SIGNING_IDENTITY` enable certificate import, signing, and verification. Adding `APPLE_ID`, `APPLE_APP_PASSWORD`, and `APPLE_TEAM_ID` enables notarization; the scheduled finalize workflow staples accepted tickets and replaces the release asset.

The helper script can prepare and upload signing secrets through GitHub CLI:

```bash
./scripts/setup-apple-signing-secrets.sh \
  --cert ~/Certificates/developer-id-application.p12 \
  --cert-password 'export-password' \
  --identity 'Developer ID Application: Example Corp (TEAMID1234)' \
  --repo 'OWNER/REPOSITORY' \
  --set-gh-secrets
```

Omit the notarization flags when signing only. See the workflow files for the complete CI matrix and release details.