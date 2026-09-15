# MCP Examiner

MCP Examiner is a desktop workbench and headless CLI for inspecting, calling, and testing [Model Context Protocol](https://modelcontextprotocol.io/) servers. It combines a Tauri 2 interface with a shared Rust engine, so the same normalized profiles and test sets can be used interactively or in automation.

![MCP Examiner tool workbench](docs/assets/tool-workbench.png)

## What it does

- Import MCP server definitions from VS Code, Claude, MCP Inspector, or generic MCP JSON.
- Connect over standard I/O, Streamable HTTP, HTTP + SSE, WebSocket, or auto-detected remote transport.
- Inspect negotiated protocol versions, server capabilities, tools, resources, prompts, and session traffic.
- Call tools and read resources with schema-aware forms, raw JSON controls, and formatted results.
- Author, generate, validate, and run JSON or YAML test sets with assertions.
- Save every automated run as a self-contained HTML report plus a redacted YAML result model.
- Handle OAuth discovery and PKCE browser login while keeping credentials in the OS keychain.

## Documentation

The guides in [`docs/`](docs/index.md) are plain Markdown and are organized so they can be rendered by VitePress, MkDocs, GitHub Pages, or another modern static site generator:

- [Documentation home](docs/index.md)
- [Install and first connection](docs/getting-started.md)
- [Workbench guide](docs/workbench.md)
- [Automated tests and reports](docs/automation.md)
- [OAuth and secret handling](docs/oauth.md)
- [Architecture and development](docs/architecture.md)
- [MCP test set format](docs/suite-format.md)

## Quick start

Install the JavaScript dependencies and start the desktop application:

```bash
npm install
npm run tauri dev
```

In the app, choose **Paste MCP JSON** or **Import config**, preview the normalized profiles, and import them. Select a server and choose **Connect**. The fastest local example is the repository fixture configuration:

```text
tests/fixtures/configs/runner.mcp.json
```

The frontend can also run by itself at `http://localhost:1420`:

```bash
npm run dev
```

Browser-only development does not provide the Tauri commands used for file dialogs, keychain access, connections, or reports. Use the desktop runtime for those workflows.

## CLI

The CLI shares the Rust engine with the desktop app:

```bash
npm run cli -- import-config .vscode/mcp.json
npm run cli -- versions
npm run cli -- validate tests/fixtures/basic.mcp-test.yaml
```

Run a test set against a named server and write the adjacent HTML/YAML report pair:

```bash
npm run cli -- run tests/fixtures/basic.mcp-test.yaml \
  --config tests/fixtures/configs/runner.mcp.json \
  --server fixture \
  --workspace-folder . \
  --report mcp-examiner-report.html
```

See [Automated tests and reports](docs/automation.md) for input resolution, assertions, exit codes, and report contents.

## Development checks

```bash
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Build a macOS application bundle with:

```bash
npm run tauri build
open "target/release/bundle/macos/MCP Examiner.app"
```

For release signing, CI, and repository conventions, see [Architecture and development](docs/architecture.md).

