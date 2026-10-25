import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentHome } from "../core/session.ts";

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  /** Loopback port for the redirect URI. Defaults to 4318. */
  redirectPort?: number;
  audience?: string;
  extraAuthorizationParams?: Record<string, string>;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

export interface OAuthOptions {
  openUrl?: (url: string) => Promise<void>;
  force?: boolean;
  timeoutMs?: number;
}

export function tokenStorePath(): string {
  return path.join(agentHome(), "mcp-auth.json");
}

async function readStore(): Promise<Record<string, OAuthToken>> {
  try {
    const raw = JSON.parse(await readFile(tokenStorePath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, OAuthToken>)
      : {};
  } catch {
    return {};
  }
}

async function writeStore(store: Record<string, OAuthToken>): Promise<void> {
  await mkdir(path.dirname(tokenStorePath()), { recursive: true });
  await writeFile(tokenStorePath(), JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearToken(server: string): Promise<void> {
  const store = await readStore();
  delete store[server];
  await writeStore(store);
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

async function tokenRequest(
  config: OAuthConfig,
  params: URLSearchParams,
): Promise<OAuthToken> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OAuth token endpoint returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("OAuth token endpoint returned invalid JSON.");
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("OAuth token response is missing access_token.");
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      typeof body.expires_in === "number"
        ? Date.now() + body.expires_in * 1000
        : undefined,
    tokenType: typeof body.token_type === "string" ? body.token_type : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

async function refresh(
  config: OAuthConfig,
  token: OAuthToken,
): Promise<OAuthToken> {
  if (!token.refreshToken) throw new Error("No refresh token.");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: config.clientId,
  });
  if (config.clientSecret) params.set("client_secret", config.clientSecret);
  const refreshed = await tokenRequest(config, params);
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? token.refreshToken,
  };
}

function waitForCode(
  port: number,
  expectedState: string,
  timeoutMs: number,
): { promise: Promise<string>; close: () => void } {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  let settled = false;
  const promise = new Promise<string>((resolve, reject) => {
    resolveCode = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    rejectCode = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<html><body>Authorization complete. You can close this window.</body></html>",
    );
    const error = url.searchParams.get("error");
    if (error) {
      rejectCode(
        new Error(
          `OAuth authorization failed: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim(),
        ),
      );
      return;
    }
    if (url.searchParams.get("state") !== expectedState) {
      rejectCode(new Error("OAuth state mismatch."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      rejectCode(new Error("OAuth callback did not include a code."));
      return;
    }
    resolveCode(code);
  });

  server.on("error", (error) => rejectCode(error));
  server.listen(port, "127.0.0.1");

  const timer = setTimeout(() => {
    rejectCode(new Error("OAuth authorization timed out."));
  }, timeoutMs);
  timer.unref?.();

  return {
    promise,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

async function authorize(
  config: OAuthConfig,
  options: OAuthOptions,
): Promise<OAuthToken> {
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  const port = config.redirectPort ?? 4318;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const callback = waitForCode(port, state, options.timeoutMs ?? 180_000);

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  if (config.audience) url.searchParams.set("audience", config.audience);
  for (const [key, value] of Object.entries(
    config.extraAuthorizationParams ?? {},
  )) {
    url.searchParams.set(key, value);
  }

  try {
    await (options.openUrl ?? openBrowser)(url.toString());
    const code = await callback.promise;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    });
    if (config.clientSecret) params.set("client_secret", config.clientSecret);
    return await tokenRequest(config, params);
  } finally {
    callback.close();
  }
}

/**
 * Return a valid access token for an MCP server, refreshing or running the
 * authorization-code + PKCE flow as needed. Tokens are stored per server in
 * `mcp-auth.json` with mode 0600.
 */
export async function ensureToken(
  server: string,
  config: OAuthConfig,
  options: OAuthOptions = {},
): Promise<string> {
  const store = await readStore();
  const existing = store[server];
  const expired =
    existing?.expiresAt !== undefined
      ? existing.expiresAt - 60_000 <= Date.now()
      : false;

  if (!options.force && existing && !expired) return existing.accessToken;

  if (existing?.refreshToken && expired) {
    try {
      const refreshed = await refresh(config, existing);
      store[server] = refreshed;
      await writeStore(store);
      return refreshed.accessToken;
    } catch {
      // Fall through to the interactive flow.
    }
  }

  const token = await authorize(config, options);
  store[server] = token;
  await writeStore(store);
  return token.accessToken;
}
