import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OllamaProvider } from "../src/core/ollama.ts";
import type { ChatRequest } from "../src/core/types.ts";

/** A disposable HTTP server whose behaviour is set per test. */
async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse, attempt: number) => void,
  run: (base: string, calls: () => number) => Promise<T>,
): Promise<T> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res, count);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, status: number, payload: unknown, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function ndjson(res: ServerResponse, lines: unknown[]) {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
  res.end();
}

const fast = { maxAttempts: 4, retryBaseMs: 1, retryMaxDelayMs: 5 };

test("retries a transient 503 and succeeds", async () => {
  await withServer(
    (req, res, attempt) => {
      if (req.url === "/api/tags") {
        if (attempt < 3) {
          json(res, 503, { error: "loading model" });
          return;
        }
        json(res, 200, { models: [{ name: "mock:latest" }] });
        return;
      }
      res.writeHead(404).end();
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      const models = await provider.listModels();
      assert.equal(models[0]?.name, "mock:latest");
      assert.equal(calls(), 3, "expected two failures then success");
    },
  );
});

test("does not retry a terminal 4xx", async () => {
  await withServer(
    (req, res) => {
      json(res, 400, { error: "bad request" });
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      await assert.rejects(() => provider.listModels(), /400/);
      assert.equal(calls(), 1, "a 400 must not be retried");
    },
  );
});

test("gives up after maxAttempts and reports the failure", async () => {
  await withServer(
    (req, res) => {
      json(res, 500, { error: "boom" });
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, maxAttempts: 3, retryBaseMs: 1 });
      await assert.rejects(() => provider.listModels(), /500/);
      assert.equal(calls(), 3);
    },
  );
});

test("honours Retry-After on a 429", async () => {
  const seen: number[] = [];
  await withServer(
    (req, res, attempt) => {
      if (attempt === 1) {
        json(res, 429, { error: "slow down" }, { "retry-after": "0" });
        return;
      }
      seen.push(Date.now());
      json(res, 200, { models: [] });
    },
    async (base) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      await provider.listModels();
      assert.equal(seen.length, 1);
    },
  );
});

test("retries a dropped connection and recovers", async () => {
  await withServer(
    (req, res, attempt) => {
      if (attempt < 3) {
        // Kill the socket without a response, as a restarting daemon would.
        req.socket.destroy();
        return;
      }
      json(res, 200, { models: [{ name: "recovered:latest" }] });
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      const models = await provider.listModels();
      assert.equal(models[0]?.name, "recovered:latest");
      assert.equal(calls(), 3);
    },
  );
});

test("an aborted request is not retried", async () => {
  await withServer(
    (req, res) => {
      json(res, 503, { error: "unavailable" });
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, maxAttempts: 5, retryBaseMs: 50 });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() =>
        provider.chat({
          model: "m",
          messages: [],
          tools: [],
          signal: controller.signal,
        } as ChatRequest).next(),
      );
      assert.equal(calls(), 0, "an already-aborted signal should never send");
    },
  );
});

test("chat recovers when the stream fails to establish", async () => {
  await withServer(
    (req, res, attempt) => {
      if (attempt < 2) {
        json(res, 503, { error: "model loading" });
        return;
      }
      ndjson(res, [
        { message: { role: "assistant", content: "hello" }, done: false },
        {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 3,
          eval_count: 2,
        },
      ]);
    },
    async (base, calls) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      const events = [];
      for await (const event of provider.chat({
        model: "m",
        messages: [],
        tools: [],
      } as ChatRequest)) {
        events.push(event);
      }
      assert.equal(calls(), 2);
      const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
      assert.equal(text, "hello", "text must arrive once, not once per attempt");
    },
  );
});

test("a mid-stream failure is not retried, to avoid duplicated text", async () => {
  let calls = 0;
  await withServer(
    (req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ message: { role: "assistant", content: "part" }, done: false })}\n`);
      // Tear the connection down after partial output.
      setTimeout(() => req.socket.destroy(), 10);
    },
    async (base) => {
      const provider = new OllamaProvider({ host: base, ...fast });
      let text = "";
      await assert.rejects(async () => {
        for await (const event of provider.chat({
          model: "m",
          messages: [],
          tools: [],
        } as ChatRequest)) {
          if (event.type === "text") text += event.text;
        }
      });
      assert.equal(text, "part", "partial text was yielded once");
      assert.equal(calls, 1, "mid-stream failure must not restart the request");
    },
  );
});
