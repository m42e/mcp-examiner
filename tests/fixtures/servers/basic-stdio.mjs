import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "basic-fixture", version: "1.0.0" },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            title: "Echo",
            description: "Return the supplied message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: message.params?.arguments?.message ?? "",
          },
        ],
        isError: false,
      },
    });
    return;
  }

  if (message.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resources: [
          {
            uri: "fixture://readme",
            name: "Fixture Readme",
            mimeType: "text/plain",
          },
        ],
      },
    });
    return;
  }

  if (message.method === "resources/templates/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { resourceTemplates: [] },
    });
    return;
  }

  if (message.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [
          {
            uri: message.params.uri,
            mimeType: "text/plain",
            text: "Fixture resource",
          },
        ],
      },
    });
    return;
  }

  if (message.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        prompts: [
          {
            name: "greeting",
            description: "Create a greeting",
            arguments: [{ name: "name", required: true }],
          },
        ],
      },
    });
    return;
  }

  if (message.method === "prompts/get") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Hello, ${message.params?.arguments?.name ?? "world"}!`,
            },
          },
        ],
      },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unknown method: ${message.method}` },
  });
});