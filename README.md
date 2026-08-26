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

Pull requests and pushes to `main` run the frontend, Rust, and Playwright checks through `npm run check`. The build workflow creates native Tauri bundles for Linux x86_64 and arm64, macOS Intel and Apple Silicon, and Windows x86_64. Build artifacts from pull requests and `main` are retained in GitHub Actions for 14 days.

To publish a release, update the versions in `package.json`, `Cargo.toml`, and `src-tauri/tauri.conf.json`, then push a tag with the matching `v` prefix, for example `v0.1.0`. The tagged build creates a GitHub release and attaches the platform bundles automatically.

