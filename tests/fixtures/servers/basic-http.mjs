import http from "node:http";

const port = Number.parseInt(process.argv[2], 10);

function sendJson(response, status, body, headers = {}) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  response.end(json);
}

const server = http.createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(405).end();
    return;
  }

  if (request.method === "DELETE") {
    response.writeHead(204).end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }

  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }

    if (request.headers["x-mcp-check"] !== "fixture") {
      sendJson(response, 400, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "Missing fixture header" },
      });
      return;
    }

    if (message.method === "initialize") {
      sendJson(
        response,
        200,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "1.0.0" },
          },
        },
        { "Mcp-Session-Id": "fixture-session" },
      );
      return;
    }

    if (message.method === "tools/list") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
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
      sendJson(response, 200, {
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

    sendJson(response, 404, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unknown method: ${message.method}` },
    });
  });
});

server.listen(port, "127.0.0.1");