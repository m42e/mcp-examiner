# Install and first connection

## Prerequisites

- Node.js with npm 11 or newer.
- Rust 1.85 or newer for the Cargo workspace and Tauri application.
- The native dependencies required by [Tauri 2](https://v2.tauri.app/start/prerequisites/) for your operating system.
- A local MCP server command or a remote MCP endpoint.

The desktop app is the supported runtime for file dialogs, native keychain storage, OAuth browser login, and server connections. The Vite server is useful for UI-only work, but it cannot execute those native commands.

## Install and launch

```bash
npm install
npm run tauri dev
```

The app opens with an empty workspace. The server rail on the left is where profiles are imported, added, filtered, and saved.

![Import servers dialog](assets/import-dialog.png)

## Add a server

There are three entry points:

- **Import config** in the empty workspace or **Paste MCP JSON** in the server rail opens the JSON import editor.
- **Open MCP configuration** loads an existing `.json` file through the native file picker.
- **Add MCP server** opens the structured editor for a new profile.

The importer recognizes these source families:

| Source | Typical input |
| --- | --- |
| VS Code | `mcpServers` entries from `.vscode/mcp.json` or workspace settings. |
| Claude | Claude Desktop or Claude Code MCP configuration. |
| MCP Inspector | Inspector-style server definitions. |
| Generic MCP | A normalized `mcpServers` object such as [`example-mcp.json`](../example-mcp.json). |

Choose **Preview** before importing. The preview reports the number of profiles found, the detected source, and any diagnostics. Importing replaces profiles with the same name and selects the first imported profile.

## Connect

1. Select a profile in the server rail.
2. Review its transport, endpoint or command, and protocol selection in the server header.
3. Choose **Connect**.
4. Approve the profile when prompted. The first connection marks an imported profile as trusted for interactive calls and test runs.
5. Resolve any missing environment, header, or secret inputs in the connection dialog.

For local servers, the process is started with the configured command, arguments, working directory, and environment. For remote servers, MCP Examiner connects using the configured URL and headers. OAuth-protected endpoints expose a **Log in** action only after the server requires authorization; see [OAuth and secret handling](oauth.md).

## Build and run without the Tauri CLI

Cargo commands use the embedded frontend by default:

```bash
cargo run -p mcp-examiner-app
cargo build -p mcp-examiner-app
```

Use `--no-default-features` when you need a direct Cargo launch with Vite hot reload:

```bash
cargo run --no-default-features -p mcp-examiner-app
```

Build and open the macOS bundle with:

```bash
npm run tauri build
open "target/release/bundle/macos/MCP Examiner.app"
```

## Verify the checkout

```bash
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```