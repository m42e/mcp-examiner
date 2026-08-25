# MCP Check

A native workbench for inspecting and testing Model Context Protocol servers. MCP Check is being built as a Tauri 2 desktop application with a shared Rust engine and headless CLI.

## Implemented

- Cargo workspace with reusable core, CLI, and desktop crates.
- Version contracts for every published MCP revision from `2024-11-05` through `2026-07-28`.
- Read-only normalization of VS Code, Claude-compatible, and Inspector-style JSON configurations.
- Native Open/Save support for MCP JSON configuration documents, with the active absolute path shown in the import editor.
- Persistent server-rail Open/Save actions: Open imports a selected MCP JSON file directly, while Save serializes the current live server list rather than the original pasted source.
- Structured Add/Edit Server dialog for stdio, Streamable HTTP, HTTP+SSE, Auto-detect, and WebSocket profiles, including protocol, timeout, args/cwd/env, headers, and OAuth fields; edits revoke trust. Auto-detect connects over Streamable HTTP (which transparently handles both `application/json` and `text/event-stream` responses) with protocol-version fallback.
- Resolution of `${workspaceFolder}`, `${input:id}`, `${secret:id}`, `${env:VAR}`, `${VAR}`, and `${VAR:-default}` placeholders through an explicit connection context.
- OS keychain-backed managed secrets with a full desktop management dialog for adding, editing, masked viewing, revealing, and deleting credentials; only non-sensitive labels and IDs are kept in the app data index.
- Secret toggles for server environment and header fields, which save values to the keychain and serialize `${secret:id}` references instead of plaintext.
- Typed VS Code prompt, pick, and command inputs with manual secret-safe value collection; secret inputs are stored under their input IDs for reuse, and command inputs are never executed implicitly.
- Relative `envFile` loading from the server working directory, with file values available to interpolation and explicit profile environment values taking precedence.
- Support in the normalized model for stdio, Streamable HTTP, deprecated HTTP+SSE, and WebSocket profiles.
- Diagnostics for host-specific settings that cannot be ported safely.
- Shared redaction for secret inputs, URL credentials, auth-like headers, nested JSON, and connection errors.
- Persistent stdio and Streamable HTTP sessions using the official Rust MCP SDK.
- HTTPS Streamable HTTP support with platform-verified Rustls certificates.
- Automatic fallback from modern discovery to legacy initialization for imported servers that do not declare a protocol era.
- Explicit legacy, automatic, modern, and exact-version lifecycle selection with negotiated-version verification.
- Trust confirmation before launching a local command or connecting to a remote endpoint.
- Capability-aware discovery that keeps tools, resources, templates, and prompts independent.
- Manual tool invocation with raw JSON arguments and complete MCP result rendering.
- JSON Schema argument forms for strings, numbers, integers, booleans, enums, nested objects, and repeatable arrays, with a raw JSON toggle.
- Formatted text/structured response rendering with independent Formatted/JSON toggles per top-level result field.
- Manual resource/template reads and prompt retrieval with editable parameters.
- Strict JSON/YAML parsing for the MCP Inspector test-set schema in `mcp-test.schema.json`.
- Sequential automated tool, resource, and prompt calls with literal, Rust-regex, and recursive partial-JSON assertions.
- Headless `validate` and `run` commands with pass/fail/error exit codes and CI input injection.
- Paired self-contained HTML and machine-readable YAML reports with escaped/redacted content, complete normalized server configuration, and negotiated server identity/capabilities/tools/resources/templates/prompts.
- Reports preserve each redacted declarative call definition, including tool/prompt arguments and configured expectations, alongside actual responses and assertion outcomes.
- HTML reports include a sticky left navigation for summary, configuration, server information, calls, protocol, HTTP evidence, and individual call anchors.
- Redacted semantic protocol timelines with elapsed times, active/post-disconnect history, Protocol-tab inspection, and report embedding.
- Observable Streamable HTTP requests with redacted method, URL, request headers/body, parsed response kind, session ID, errors, retained Network-tab history, and report embedding.
- Tests workspace with source editing, validation, run summaries, assertion details, and HTML export.
- Responsive Tests workspace with wrapped always-visible controls, independent source/result scrolling, and stable minimum-window layout.
- Live automated-run progress streamed from Rust: pending calls are shown immediately, active calls are marked running, and each result/assertion appears as soon as that call finishes.
- Connected-server test generation lets users choose individual discovered tools, concrete resources, and prompts. All are selected by default, Select all/Select none are available, replacing non-empty source requires confirmation, and resource templates are skipped until concrete URIs are known.
- Native Open/Save support for JSON and YAML test-set source, with stale validation/results cleared after loading.
- Desktop workbench with server filtering, connection state, protocol controls, and stable inspector panes.
- Compact live tab counts for discovered tools, resources plus templates, prompts, validated test calls, and recorded protocol messages.
- Overview recent-protocol activity backed by active or retained session history; full redacted payloads remain available in Protocol.

Deprecated HTTP+SSE execution, WebSocket execution, HTTP status/response-header/SSE-frame capture, stdio frame/stderr capture, advanced client interactions, OAuth, and the expanded matrix/task assertion model remain subsequent implementation slices.

## Development

```bash
npm install
npm run tauri dev
```

Plain Cargo development launches are also supported; the debug app starts and owns Vite when it is not already running:

```bash
cargo run -p mcp-check-app
```

Run the frontend by itself at `http://localhost:1420` with `npm run dev`. Rust-backed actions such as configuration import require the Tauri runtime.

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
	--report mcp-check-report.html
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

