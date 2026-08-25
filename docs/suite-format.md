# MCP Test Set Format

MCP Examiner accepts JSON or YAML test sets matching [`mcp-test.schema.json`](../mcp-test.schema.json). A test set has a name and an ordered list of MCP calls. Calls run sequentially on one fresh connection.

```yaml
$schema: ../mcp-test.schema.json
name: Basic server checks
description: Optional context for the report
calls:
  - type: callTool
    name: echo
    arguments:
      message: hello
    expect:
      contains: hello
      pattern: '"isError":false'
      json:
        isError: false

  - type: readResource
    uri: fixture://readme
    expect:
      contains: Read me

  - type: getPrompt
    name: greeting
    arguments:
      name: Ada
```

## Calls

- `callTool` requires `name` and accepts an optional JSON-object `arguments` value.
- `readResource` requires `uri`.
- `getPrompt` requires `name` and accepts an optional JSON-object `arguments` value.

Unknown fields are rejected. Every configured `expect` object must contain at least one check.

## Expectations

All configured checks must pass:

- `contains` searches the compact serialized JSON response for literal text.
- `pattern` applies a Rust regular expression to the compact serialized JSON response.
- `json` performs recursive partial matching. Expected object fields may be a subset; arrays must match in order and length; primitive values must match exactly.

Failures include a JSON Pointer-like path such as `$/content/0/text`.

## CLI

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

Provide unresolved client inputs with repeated `--input ID=VALUE` options. Values may contain additional `=` characters. Runs exit with `0` for pass, `1` for assertion failure, and `2` for execution error. Invalid files and CLI usage also return nonzero.

Each run writes two adjacent files with the same basename:

- `.html`: a self-contained report with inline styling, restrictive CSP, sticky left navigation, escaped server content, full redacted normalized server configuration, negotiated server information/capabilities/primitives, original call definitions and expectations, responses, assertions, and protocol/transport evidence.
- `.yaml`: the complete redacted machine-readable run model containing the same configuration, server snapshot, original call arguments/expectations, results, and evidence.

No external assets or network requests are required to view the HTML report. The Tests tab shows the exact absolute paths after saving both files.