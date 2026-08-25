import { expect, test } from "@playwright/test";

test("renders the desktop workbench and import dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");

  await expect(page.getByText("MCP Examiner", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  await expect(page.getByText("5 revisions")).toBeVisible();

  await page.getByRole("button", { name: "Import config" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import servers" });
  await expect(importDialog).toBeVisible();
  await expect(importDialog.getByRole("button", { name: "Open" })).toBeDisabled();
  await expect(importDialog.getByRole("button", { name: "Save" })).toBeDisabled();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.screenshot({ path: "test-results/workbench-desktop.png" });
});

test("keeps primary controls inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 820 });
  await page.goto("/");

  const importButton = page.getByRole("button", { name: "Import config" });
  await expect(importButton).toBeVisible();
  await importButton.click();
  await expect(page.getByRole("dialog", { name: "Import servers" })).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.screenshot({ path: "test-results/workbench-narrow.png" });
});

test("opens the managed secrets dialog from the server rail", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 820 });
  await page.goto("/");

  await page.getByRole("button", { name: "Manage secrets" }).click();
  const secretsDialog = page.getByRole("dialog", { name: "Managed secrets" });
  await expect(secretsDialog).toBeVisible();
  await expect(secretsDialog.getByText("No managed secrets")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/secrets-narrow.png" });
});

test("imports, connects, and exercises manual server primitives", async ({ page }) => {
  await page.addInitScript(() => {
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback: (payload: unknown) => void) => number;
        unregisterCallback: (id: number) => void;
        runCallback: (id: number, payload: unknown) => void;
      };
    };
    let configWriteCount = 0;
    let failNextConnection = false;
    let nextCallbackId = 1;
    const storedSecrets = new Map<string, { label: string; value: string }>();
    const callbacks = new Map<number, (payload: unknown) => void>();
    (window as typeof window & { failNextConnection: () => void }).failNextConnection = () => {
      failNextConnection = true;
    };
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: (callback) => {
        const id = nextCallbackId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      runCallback: (id, payload) => callbacks.get(id)?.(payload),
      invoke: async (command, args) => {
        if (command === "plugin:dialog|open") {
          const filters = (args?.options as { filters?: { name: string }[] } | undefined)?.filters;
          return filters?.[0]?.name === "MCP test set"
            ? "/tmp/loaded.mcp-test.yaml"
            : "/tmp/loaded.mcp.json";
        }
        if (command === "plugin:dialog|save") {
          const filters = (args?.options as { filters?: { name: string }[] } | undefined)?.filters;
          return filters?.[0]?.name === "MCP test set"
            ? "/tmp/saved.mcp-test.yaml"
            : "/tmp/saved.mcp.json";
        }
        if (command === "read_document") {
          const path = args?.path as string;
          return path.endsWith(".json")
            ? '{"mcpServers":{"fixture":{"command":"node","args":["fixture.mjs"]}}}'
            : "name: Loaded test\ncalls:\n  - type: readResource\n    uri: fixture://readme\n";
        }
        if (command === "write_document") {
          const request = args?.request as { path: string; content: string };
          if (request.path.endsWith(".json")) {
            configWriteCount += 1;
            if (configWriteCount === 1 && (!request.content.includes('"direct-server"') || !request.content.includes("https://edited.test/mcp") || !request.content.includes("${secret:direct-server-authorization}"))) {
              throw new Error("Persistent config save did not serialize the live server list");
            }
          }
          return request.path;
        }
        if (command === "app_info") {
          return {
            name: "MCP Examiner",
            version: "0.1.0",
            formatVersion: 1,
            protocolVersions: [
              "2024-11-05",
              "2025-03-26",
              "2025-06-18",
              "2025-11-25",
              "2026-07-28",
            ],
          };
        }
        if (command === "list_secrets") {
          return [...storedSecrets].map(([id, secret]) => ({
            id,
            label: secret.label,
            updatedAtUnixMs: 1,
            available: true,
          }));
        }
        if (command === "set_secret") {
          const request = args?.request as { id: string; label: string; value: string };
          storedSecrets.set(request.id, { label: request.label, value: request.value });
          return {
            id: request.id,
            label: request.label,
            updatedAtUnixMs: 1,
            available: true,
          };
        }
        if (command === "get_secret") {
          const secret = storedSecrets.get(args?.id as string);
          if (secret === undefined) throw new Error("Secret is unavailable");
          return secret.value;
        }
        if (command === "delete_secret") {
          storedSecrets.delete(args?.id as string);
          return null;
        }
        if (command === "import_config_preview") {
          return {
            formatVersion: 1,
            sourceKind: "claude",
            diagnostics: [],
            inputs: [
              {
                id: "api-token",
                kind: "prompt",
                description: "API token",
                secret: true,
                defaultValue: null,
                options: [],
              },
            ],
            profiles: [
              {
                formatVersion: 1,
                name: "fixture",
                transport: {
                  type: "stdio",
                  command: "node",
                  args: ["fixture.mjs"],
                  cwd: null,
                  env: { API_TOKEN: "${input:api-token}" },
                  envFile: null,
                },
                protocol: { mode: "exact", version: "2025-11-25" },
                source: { kind: "claude", path: null, scope: null },
                timeoutMs: 5000,
                trusted: false,
              },
            ],
          };
        }
        if (command === "connect_server") {
          if (failNextConnection) {
            failNextConnection = false;
            throw new Error("MCP connection failed: automatic discovery failed (modern transport returned HTTP 404 Not Found while requesting server/discover); legacy fallback failed (legacy transport returned HTTP 404 Not Found while sending initialize request)");
          }
          const context = args?.context as { inputs?: Record<string, string> } | undefined;
          if (context?.inputs?.["api-token"] !== "test-secret") {
            throw new Error("Connection input was not supplied through the resolution context");
          }
          return {
            serverName: "fixture",
            protocolVersion: "2025-11-25",
            serverInfo: { name: "fixture", version: "1.0.0" },
            capabilities: { tools: {}, resources: {}, prompts: {} },
            instructions: null,
            discoveryErrors: {},
            tools: [
              {
                name: "echo",
                title: "Echo",
                description: "Return the supplied message",
                inputSchema: {
                  type: "object",
                  properties: {
                    message: {
                      type: "string",
                      description: "The message to return in the tool response.",
                    },
                    mode: {
                      type: "string",
                      enum: ["fast", "thorough"],
                      description: "Choose how much processing the tool should perform.",
                    },
                    count: {
                      type: "integer",
                      default: 2,
                      description: "Maximum number of results to return in one pass.",
                    },
                    enabled: {
                      type: "boolean",
                      default: true,
                      description: "Include optional output in the response.",
                    },
                  },
                },
                outputSchema: null,
                annotations: null,
                metadata: null,
              },
            ],
            resources: [
              {
                uri: "fixture://readme",
                name: "Fixture Readme",
                mimeType: "text/plain",
              },
            ],
            resourceTemplates: [],
            prompts: [
              {
                name: "greeting",
                description: "Create a greeting",
                arguments: [{ name: "name", required: true }],
              },
            ],
          };
        }
        if (command === "call_tool") {
          return { content: [{ type: "text", text: "hello" }], isError: false };
        }
        if (command === "read_resource") {
          return {
            contents: [
              { uri: "fixture://readme", mimeType: "text/plain", text: "Read me" },
            ],
          };
        }
        if (command === "get_prompt") {
          return {
            messages: [
              { role: "user", content: { type: "text", text: "Hello, Ada!" } },
            ],
          };
        }
        if (command === "validate_test_set") {
          const content = args?.content as string;
          try {
            return (JSON.parse(content) as { calls?: unknown[] }).calls?.length ?? 0;
          } catch {
            return [...content.matchAll(/^\s*-\s+type:/gm)].length;
          }
        }
        if (command === "run_automated_test") {
          const progress = args?.onProgress as { onmessage: (message: unknown) => void };
          const call = {
            index: 1,
            operation: "callTool",
            target: "echo",
            status: "passed",
            durationMs: 4,
            response: { content: [{ type: "text", text: "hello" }] },
            assertions: [
              { kind: "contains", passed: true, message: 'response contains "hello"' },
            ],
            error: null,
          };
          progress.onmessage({
            event: "started",
            name: "Server smoke test",
            total: 1,
            calls: [{ index: 1, operation: "callTool", target: "echo" }],
          });
          progress.onmessage({ event: "connected", protocolVersion: "2025-11-25" });
          progress.onmessage({ event: "callStarted", index: 1, operation: "callTool", target: "echo" });
          await new Promise((resolve) => setTimeout(resolve, 250));
          progress.onmessage({
            event: "callFinished",
            call,
            summary: { total: 1, passed: 1, failed: 0, errors: 0 },
          });
          return {
            result: {
              formatVersion: 1,
              name: "Server smoke test",
              description: null,
              serverName: "fixture",
              protocolVersion: "2025-11-25",
              status: "passed",
              startedAtUnixMs: 1,
              durationMs: 12,
              summary: { total: 1, passed: 1, failed: 0, errors: 0 },
              calls: [call],
              connectionError: null,
              shutdownError: null,
            },
            reportHtml: "<!doctype html><title>Server smoke test</title>",
            reportYaml: "name: Server smoke test\nstatus: passed\n",
          };
        }
        if (command === "save_report_bundle") {
          return {
            htmlPath: "/tmp/server-smoke-test.html",
            yamlPath: "/tmp/server-smoke-test.yaml",
          };
        }
        if (command === "session_events") {
          return [
            {
              sequence: 1,
              elapsedMs: 0,
              direction: "internal",
              method: "session/connect",
              payload: { protocolVersion: "2025-11-25" },
            },
            {
              sequence: 2,
              elapsedMs: 4,
              direction: "clientToServer",
              method: "tools/call",
              payload: { name: "echo" },
            },
          ];
        }
        if (command === "http_observations") {
          return [
            {
              sequence: 1,
              elapsedMs: 2,
              method: "POST",
              url: "https://example.test/mcp",
              requestHeaders: { authorization: "[REDACTED]" },
              requestBody: { method: "tools/call" },
              responseKind: "json",
              responseBody: { jsonrpc: "2.0", result: { content: [{ text: "hello" }] } },
              sessionId: "fixture-session",
              error: null,
            },
          ];
        }
        if (command === "disconnect_server") return null;
        throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
      },
    };
  });

  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");

  await page.getByRole("button", { name: "Open MCP configuration" }).click();
  await expect(page.getByRole("heading", { name: "fixture" })).toBeVisible();

  await page.getByRole("button", { name: "Add MCP server" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add MCP server" });
  await addDialog.getByLabel("Name").fill("direct-server");
  await addDialog.getByLabel("URL", { exact: true }).fill("https://direct.test/mcp");
  await addDialog.getByRole("button", { name: "Add headers" }).click();
  await addDialog.getByLabel("Headers key 1").fill("Authorization");
  await addDialog.getByLabel("Headers value 1").fill("direct-secret");
  await addDialog.getByLabel("Mark Headers 1 as secret").check();
  await addDialog.getByRole("button", { name: "Save server" }).click();
  await expect(page.getByRole("heading", { name: "direct-server" })).toBeVisible();

  await page.getByRole("button", { name: "Edit MCP server" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit MCP server" });
  await editDialog.getByLabel("URL", { exact: true }).fill("https://edited.test/mcp");
  await editDialog.getByRole("button", { name: "Save server" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "https://edited.test/mcp" })).toBeVisible();
  await page.getByRole("button", { name: "Save MCP configuration" }).click();

  await page.getByRole("button", { name: "Paste MCP JSON" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import servers" });
  await importDialog.getByRole("button", { name: "Open" }).click();
  await expect(importDialog.getByText("/tmp/loaded.mcp.json")).toBeVisible();
  await importDialog.getByRole("button", { name: "Save" }).click();
  await expect(importDialog.getByText("/tmp/saved.mcp.json")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("1 servers found")).toBeVisible();
  await page.getByRole("button", { name: "Import 1" }).click();

  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Start local server" })).toHaveCount(0);
  const resolutionDialog = page.getByRole("dialog", { name: "Connect to fixture" });
  await expect(resolutionDialog).toBeVisible();
  const tokenInput = page.getByLabel("API token");
  await expect(tokenInput).toHaveAttribute("type", "password");
  await tokenInput.fill("test-secret");
  await resolutionDialog.locator('button[type="submit"]').click();
  await expect(page.getByText("Connected / 2025-11-25")).toBeVisible();
  await page.getByRole("button", { name: "Manage secrets" }).click();
  const secretsDialog = page.getByRole("dialog", { name: "Managed secrets" });
  await expect(secretsDialog.locator(".secret-row").filter({ hasText: "api-token" })).toBeVisible();
  await expect(secretsDialog.getByText("********", { exact: true }).first()).toBeVisible();
  await secretsDialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Manage secrets" }).click();
  const managedSecrets = page.getByRole("dialog", { name: "Managed secrets" });
  await managedSecrets.getByRole("button", { name: "Add secret" }).click();
  await managedSecrets.getByLabel("Secret ID").fill("release-token");
  await managedSecrets.getByLabel("Label").fill("Release token");
  await managedSecrets.getByLabel("Value").fill("release-secret");
  await managedSecrets.getByRole("button", { name: "Save secret" }).click();
  const releaseRow = managedSecrets.locator(".secret-row").filter({ hasText: "release-token" });
  await expect(releaseRow).toContainText("Release token");
  await releaseRow.getByRole("button", { name: "Reveal Release token" }).click();
  await expect(releaseRow.getByText("release-secret", { exact: true })).toBeVisible();
  await releaseRow.getByRole("button", { name: "Edit Release token" }).click();
  await managedSecrets.getByLabel("Replacement value").fill("replacement-secret");
  await managedSecrets.getByRole("button", { name: "Save secret" }).click();
  await expect(releaseRow.getByText("********", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await releaseRow.getByRole("button", { name: "Delete Release token" }).click();
  await expect(releaseRow).toHaveCount(0);
  await managedSecrets.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Echo" })).toBeVisible();
  await expect(page.getByLabel("1 tools")).toBeVisible();
  await expect(page.getByLabel("1 resources")).toBeVisible();
  await expect(page.getByLabel("1 prompts")).toBeVisible();
  await expect(page.getByLabel("2 messages")).toBeVisible();
  await expect(page.getByLabel("1 tests")).toBeVisible();

  await page.getByRole("button", { name: "Tests" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  const generateDialog = page.getByRole("dialog", { name: "Select tests to generate" });
  await expect(generateDialog).toBeVisible();
  await expect(generateDialog.getByRole("checkbox")).toHaveCount(3);
  for (const checkbox of await generateDialog.getByRole("checkbox").all()) {
    await expect(checkbox).toBeChecked();
  }
  await generateDialog.getByRole("button", { name: "Select none" }).click();
  for (const checkbox of await generateDialog.getByRole("checkbox").all()) {
    await expect(checkbox).not.toBeChecked();
  }
  await expect(generateDialog.getByRole("button", { name: "Replace and generate" })).toBeDisabled();
  await generateDialog.getByRole("button", { name: "Select all" }).click();
  await generateDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Test set source")).toHaveValue(/Server smoke test/);

  await page.getByRole("button", { name: "Generate" }).click();
  await generateDialog.getByRole("checkbox", { name: /Fixture Readme/ }).uncheck();
  await generateDialog.getByRole("button", { name: "Replace and generate" }).click();
  const generatedSource = page.getByLabel("Test set source");
  await expect(generatedSource).toHaveValue(/"name": "echo"/);
  await expect(generatedSource).not.toHaveValue(/"uri": "fixture:\/\/readme"/);
  await expect(generatedSource).toHaveValue(/"name": "greeting"/);
  await expect(generatedSource).toHaveValue(/"mode": "fast"/);
  await expect(generatedSource).toHaveValue(/"count": 2/);
  await expect(generatedSource).toHaveValue(/"enabled": true/);
  await expect(page.getByLabel("2 tests")).toBeVisible();
  await page.getByRole("button", { name: "Tools" }).click();

  const argumentLayout = await page.locator(".schema-fields").first().evaluate((form) => ({
    fits: form.scrollWidth <= form.clientWidth,
    fields: [...form.querySelectorAll(":scope > .schema-field")].map((field) => {
      const label = field.querySelector(":scope > span")?.getBoundingClientRect();
      const description = field.querySelector(":scope > small")?.getBoundingClientRect();
      const control = field.querySelector(":scope > input, :scope > select")?.getBoundingClientRect();
      const bounds = field.getBoundingClientRect();
      return {
        stacked: Boolean(label && control && control.top >= (description?.bottom ?? label.bottom)),
        contained: Boolean(control && control.left >= bounds.left && control.right <= bounds.right + 1),
      };
    }),
  }));
  expect(argumentLayout.fits).toBe(true);
  expect(argumentLayout.fields.every((field) => field.stacked && field.contained)).toBe(true);
  await page.screenshot({ path: "test-results/workbench-tools.png" });

  await page.setViewportSize({ width: 720, height: 820 });
  expect(await page.locator(".tool-detail").evaluate((detail) => detail.scrollWidth <= detail.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workbench-tools-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 920 });

  await page.getByRole("textbox", { name: /^message\b/ }).fill("hello");
  await page.getByRole("combobox", { name: /^mode\b/ }).selectOption({ label: "thorough" });
  await page.getByRole("spinbutton", { name: /^count\b/ }).fill("3");
  await expect(page.getByRole("checkbox", { name: /^enabled\b/ })).toBeChecked();
  await page.getByRole("button", { name: "Run tool" }).click();
  await expect(page.getByText("hello", { exact: true })).toBeVisible();
  const contentField = page.locator(".result-field").filter({ hasText: "content" });
  await contentField.getByRole("button", { name: "JSON" }).click();
  await expect(contentField.getByText(/"text": "hello"/)).toBeVisible();

  await page.getByRole("button", { name: "Resources" }).click();
  await page.getByRole("button", { name: "Read resource" }).click();
  await expect(page.getByText("Read me", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Prompts" }).click();
  await page.getByLabel("name").fill("Ada");
  await page.getByRole("button", { name: "Get prompt" }).click();
  await expect(page.getByText("Hello, Ada!", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Protocol" }).click();
  await expect(page.getByText("session/connect", { exact: true })).toBeVisible();
  await expect(page.getByText("tools/call", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Network" }).click();
  const networkObservation = page.locator(".protocol-events details").first();
  await expect(networkObservation).toContainText("json / https://example.test/mcp");
  await networkObservation.locator("summary").click();
  await expect(networkObservation.getByRole("heading", { name: "Response" })).toBeVisible();
  await expect(networkObservation.getByText(/\"text\": \"hello\"/)).toBeVisible();

  await page.screenshot({ path: "test-results/workbench-connected.png" });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(page.locator(".overview-events").getByText("session/connect", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Tests" }).click();
  const testsPanel = page.locator(".automation-editor");
  await page.setViewportSize({ width: 1040, height: 720 });
  const toolbarFits = await testsPanel.evaluate((editor) => {
    const editorBounds = editor.getBoundingClientRect();
    return [...editor.querySelectorAll(".panel-actions button")].every((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.left >= editorBounds.left && bounds.right <= editorBounds.right + 1;
    });
  });
  expect(toolbarFits).toBe(true);
  expect(await testsPanel.evaluate((editor) => editor.scrollWidth <= editor.clientWidth)).toBe(true);
  await testsPanel.getByRole("button", { name: "Open" }).click();
  await expect(testsPanel.getByText("/tmp/loaded.mcp-test.yaml")).toBeVisible();
  await testsPanel.getByRole("button", { name: "Save" }).click();
  await expect(testsPanel.getByText("/tmp/saved.mcp-test.yaml")).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Tests" }).click();
  await expect(page.locator(".automation-editor").getByText("/tmp/saved.mcp-test.yaml")).toBeVisible();
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Valid test set / 1 calls")).toBeVisible();
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(page.locator(".run-summary strong")).toHaveText("running");
  await expect(page.locator(".call-running")).toBeVisible();
  await expect(page.getByLabel("Run progress")).toBeVisible();
  await expect(page.getByText("1 passed")).toBeVisible();
  await page.locator(".run-calls summary").click();
  await expect(page.getByText('response contains "hello"')).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Tests" }).click();
  await expect(page.locator(".run-summary strong")).toHaveText("passed");
  await page.locator(".run-calls summary").click();
  await expect(page.getByText('response contains "hello"')).toBeVisible();
  await page.getByRole("button", { name: "Save HTML + YAML" }).click();
  await expect(page.getByText("/tmp/server-smoke-test.html")).toBeVisible();
  await expect(page.getByText("/tmp/server-smoke-test.yaml")).toBeVisible();

  await page.getByRole("button", { name: "Overview" }).click();
  await page.evaluate(() => window.failNextConnection());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const connectionToast = page.getByRole("alert");
  await expect(connectionToast).toContainText("automatic discovery failed");
  await connectionToast.getByRole("button", { name: "Dismiss connection error" }).click();
  await expect(connectionToast).toHaveCount(0);
  await page.getByRole("button", { name: "Console" }).click();
  await expect(page.getByRole("alert")).toContainText("MCP connection failed: automatic discovery failed");
  await expect(page.locator(".console-error pre")).toContainText("legacy fallback failed");
});
