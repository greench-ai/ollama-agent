#!/usr/bin/env node
// Minimal MCP stdio server used by the tests. Not a general-purpose server:
// it implements initialize, tools/list, tools/call, and ping.
import { createInterface } from "node:readline";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;

  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "echo-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the provided text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "write_note",
            description: "Pretend to write a note.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: "note://hello",
            name: "Hello note",
            mimeType: "text/plain",
          },
        ],
      },
    });
    return;
  }
  if (method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri: params?.uri ?? "note://hello",
            mimeType: "text/plain",
            text: "resource-body",
          },
        ],
      },
    });
    return;
  }
  if (method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [
          {
            name: "greet",
            description: "Greet someone by name.",
            arguments: [{ name: "name", required: true }],
          },
        ],
      },
    });
    return;
  }
  if (method === "prompts/get") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        description: "Greeting",
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Hello, ${params?.arguments?.name ?? "world"}` },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const text = params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `echo:${text}` }],
        isError: false,
      },
    });
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
