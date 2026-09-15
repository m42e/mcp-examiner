# Automated tests and reports

MCP Examiner test sets are JSON or YAML documents containing a name, optional description, and an ordered list of MCP calls. The complete syntax is documented in [MCP test set format](suite-format.md), and the machine-readable contract is [`mcp-test.schema.json`](../mcp-test.schema.json).

## Create a test set in the app

1. Connect to a server so its tools, resources, and prompts are discovered.
2. Open the **Tests** tab.
3. Choose **Generate** to select discovered tools, concrete resources, and prompts. Generated arguments are initialized from their schemas.
4. Edit the JSON or YAML source, or use **Open** to load an existing test set.
5. Choose **Validate** to parse the document without connecting.
6. Choose **Run all** to run calls sequentially on a fresh session.

The editor shows live call counts and validation messages. During a run it reports each call as pending, running, passed, failed, or error. A test run must be trusted through **Connect** first.

## Call types

```yaml
name: Basic server checks
description: Smoke checks for the fixture server
calls:
  - type: callTool
    name: echo
    arguments:
      message: hello
    expect:
      contains: hello

  - type: readResource
    uri: fixture://readme

  - type: getPrompt
    name: greeting
    arguments:
      name: Ada
```

Supported calls are:

- `callTool` with a tool name and optional object arguments.
- `readResource` with a resource URI.
- `getPrompt` with a prompt name and optional object arguments.

Unknown fields are rejected. Calls execute in document order on one fresh connection for each run.

## Expectations

Each expectation can use one or more checks, and all configured checks must pass:

- `contains` searches the compact serialized JSON response for literal text.
- `pattern` applies a Rust regular expression to the compact serialized JSON response.
- `json` performs recursive partial matching. Object fields may be a subset; arrays must match in order and length; primitive values must match exactly.

Assertion failures include a JSON Pointer-like path such as `$/content/0/text` when a nested value differs.

## CLI workflow

Validate without connecting:

```bash
npm run cli -- validate tests/fixtures/basic.mcp-test.yaml
```

Run against a server imported from an existing MCP client configuration:

```bash
npm run cli -- run tests/fixtures/basic.mcp-test.yaml \
  --config tests/fixtures/configs/runner.mcp.json \
  --server fixture \
  --workspace-folder . \
  --report mcp-examiner-report.html
```

Use repeated `--input ID=VALUE` options for unresolved client inputs. Values may contain additional `=` characters. If a config contains multiple servers, `--server` is required; a single-server config can omit it.

The CLI exits with:

| Code | Meaning |
| --- | --- |
| `0` | All calls and assertions passed. |
| `1` | The run completed but at least one assertion failed. |
| `2` | The run could not complete because of a connection or execution error. |

Invalid documents and CLI usage errors also return nonzero.

## Reports

Every run writes two adjacent files with the same basename:

- `.html`: a self-contained, styled report with restrictive CSP, sticky navigation, redacted server configuration, negotiated server snapshot, original call definitions, responses, assertions, and protocol/transport evidence.
- `.yaml`: the complete redacted machine-readable run model with the same configuration, snapshot, call arguments and expectations, results, and evidence.

The app's **Save HTML + YAML** action accepts an HTML target path and displays the two absolute paths after writing. No external assets or network requests are needed to open the generated HTML report.