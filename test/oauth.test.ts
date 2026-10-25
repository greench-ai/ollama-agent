import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../src/mcp/client.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { ensureToken, tokenStorePath } from "../src/mcp/oauth.ts";

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += (chunk as Buffer).toString("utf8");
  return body;
}

interface FixtureOptions {
  /** expires_in returned for authorization_code grants */
  expiresIn: number;
  /** Which bearer tokens the MCP endpoint accepts */
  acceptToken: (token: string) => boolean;
}

async function startOAuthFixture(options: FixtureOptions) {
  let issued = 0;
  let authorizationCalls = 0;
  const tokenCalls: Array<Record<string, string>> = [];
  const authHeaders: string[] = [];

  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/authorize") {
        authorizationCalls += 1;
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const location = `${redirect}?code=test-code&state=${encodeURIComponent(state)}`;
        response.writeHead(302, { location }).end();
        return;
      }

      if (url.pathname === "/token") {
        const params = Object.fromEntries(new URLSearchParams(await readBody(request)));
        tokenCalls.push(params);
        if (params.grant_type === "authorization_code") {
          if (params.code !== "test-code" || !params.code_verifier) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          issued += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: `token-${issued}`,
              refresh_token: `refresh-${issued}`,
              expires_in: options.expiresIn,
              token_type: "Bearer",
            }),
          );
          return;
        }
        if (params.grant_type === "refresh_token") {
          issued += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: `token-${issued}`,
              refresh_token: `refresh-${issued}`,
              expires_in: 3600,
              token_type: "Bearer",
            }),
          );
          return;
        }
        response.writeHead(400).end();
        return;
      }

      if (url.pathname === "/mcp") {
        const authorization = request.headers.authorization ?? "";
        authHeaders.push(authorization);
        const token = authorization.replace(/^Bearer\s+/i, "");
        if (!options.acceptToken(token)) {
          response
            .writeHead(401, { "www-authenticate": 'Bearer realm="test"' })
            .end();
          return;
        }
        const message = JSON.parse((await readBody(request)) || "{}") as {
          id?: number;
          method?: string;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (message.method === "initialize") {
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "oauth-fixture", version: "1.0.0" },
          };
        } else if (message.method === "tools/list") {
          result = {
            tools: [
              {
                name: "ping",
                description: "Ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }

      response.writeHead(404).end();
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ issued, authorizationCalls, tokenCalls, authHeaders }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function fakeBrowser(url: string): Promise<void> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  assert.ok(location, "authorization endpoint should redirect");
  await fetch(location, { redirect: "manual" });
}

type HttpServerConfig = Extract<McpServerConfig, { url: string }>;

function configFor(baseUrl: string): HttpServerConfig {
  return {
    url: `${baseUrl}/mcp`,
    auth: {
      authorizationUrl: `${baseUrl}/authorize`,
      tokenUrl: `${baseUrl}/token`,
      clientId: "test-client",
      scopes: ["mcp.read"],
      redirectPort: 4318,
    },
  };
}

test("ensureToken authorizes, persists 0600, and refreshes when expired", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-oauth-home-"));
  const fixture = await startOAuthFixture({
    expiresIn: 0,
    acceptToken: () => true,
  });
  try {
    const first = await ensureToken("srv", configFor(fixture.url).auth!, {
      openUrl: fakeBrowser,
    });
    assert.equal(first, "token-1");

    const mode = (await stat(tokenStorePath())).mode & 0o777;
    assert.equal(mode, 0o600);

    const second = await ensureToken("srv", configFor(fixture.url).auth!, {
      openUrl: fakeBrowser,
    });
    assert.equal(second, "token-2", "expired token is refreshed");

    const stats = fixture.stats();
    assert.equal(stats.authorizationCalls, 1);
    assert.deepEqual(
      stats.tokenCalls.map((call) => call.grant_type),
      ["authorization_code", "refresh_token"],
    );
  } finally {
    await fixture.close();
  }
});

test("McpClient obtains a token and retries once after a 401", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-oauth-home-"));
  const fixture = await startOAuthFixture({
    expiresIn: 3600,
    // Reject the proactively issued token so the retry path runs.
    acceptToken: (token) => token === "token-2",
  });
  try {
    const client = await McpClient.connect("srv", configFor(fixture.url), {
      openUrl: fakeBrowser,
    });
    try {
      const tools = await client.listTools();
      assert.equal(tools[0].name, "ping");
    } finally {
      await client.close();
    }

    const stats = fixture.stats();
    assert.equal(stats.issued, 2, "re-authorized once after 401");
    assert.ok(stats.authHeaders.includes("Bearer token-1"));
    assert.ok(stats.authHeaders.includes("Bearer token-2"));
  } finally {
    await fixture.close();
  }
});
