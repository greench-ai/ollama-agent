import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentHome } from "../core/session.ts";

export interface OAuthConfig {
  type?: "oauth";
  /** Explicit endpoints; when omitted, discovery is used. */
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Override the registration endpoint from authorization-server metadata. */
  registrationUrl?: string;
  /** Override the protected-resource metadata URL (RFC 9728). */
  resourceMetadataUrl?: string;
  scopes?: string[];
  /** Loopback port for the redirect URI. Defaults to 4318. */
  redirectPort?: number;
  audience?: string;
  clientName?: string;
  extraAuthorizationParams?: Record<string, string>;
}

export interface ResolvedOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  redirectPort: number;
  audience?: string;
  resource?: string;
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
  /** MCP server URL; required for discovery. */
  serverUrl: string;
  openUrl?: (url: string) => Promise<void>;
  force?: boolean;
  timeoutMs?: number;
  /** WWW-Authenticate header from a 401 response. */
  wwwAuthenticate?: string;
}

interface StoredClient {
  clientId: string;
  clientSecret?: string;
  redirectPort: number;
  registeredAt: string;
}

export function tokenStorePath(): string {
  return path.join(agentHome(), "mcp-auth.json");
}

function clientStorePath(): string {
  return path.join(agentHome(), "mcp-clients.json");
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readStore(): Promise<Record<string, OAuthToken>> {
  return readJsonFile<Record<string, OAuthToken>>(tokenStorePath(), {});
}

function writeStore(store: Record<string, OAuthToken>): Promise<void> {
  return writePrivateJson(tokenStorePath(), store);
}

function readClientStore(): Promise<Record<string, StoredClient>> {
  return readJsonFile<Record<string, StoredClient>>(clientStorePath(), {});
}

function writeClientStore(store: Record<string, StoredClient>): Promise<void> {
  return writePrivateJson(clientStorePath(), store);
}

export async function clearToken(server: string): Promise<void> {
  const tokens = await readStore();
  delete tokens[server];
  await writeStore(tokens);
  const clients = await readClientStore();
  delete clients[server];
  await writeClientStore(clients);
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

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${url} did not return a JSON object`);
  }
  return body as Record<string, unknown>;
}

export function parseResourceMetadata(header?: string): string | undefined {
  if (!header) return undefined;
  const quoted = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted) return quoted[1];
  const bare = /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return bare?.[1];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function resourceMetadataCandidates(
  serverUrl: string,
  auth: OAuthConfig,
  options: OAuthOptions,
): string[] {
  const explicit =
    auth.resourceMetadataUrl ?? parseResourceMetadata(options.wwwAuthenticate);
  if (explicit) return [explicit];
  const url = new URL(serverUrl);
  const base = `${url.origin}/.well-known/oauth-protected-resource`;
  const withPath =
    url.pathname && url.pathname !== "/" ? `${base}${url.pathname}` : base;
  return withPath === base ? [base] : [withPath, base];
}

async function discoverResourceMetadata(
  serverUrl: string,
  auth: OAuthConfig,
  options: OAuthOptions,
): Promise<{ url: string; data: Record<string, unknown> }> {
  const errors: string[] = [];
  for (const candidate of resourceMetadataCandidates(serverUrl, auth, options)) {
    try {
      return { url: candidate, data: await fetchJson(candidate) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    "Could not discover OAuth protected-resource metadata. " +
      "Configure auth.authorizationUrl, auth.tokenUrl, and auth.clientId, " +
      `or expose RFC 9728 metadata. Tried: ${errors.join("; ")}`,
  );
}

async function discoverAuthorizationServer(
  issuer: string,
): Promise<{ url: string; data: Record<string, unknown> }> {
  const base = issuer.replace(/\/+$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return { url: candidate, data: await fetchJson(candidate) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `Could not load authorization-server metadata for ${issuer}: ${errors.join("; ")}`,
  );
}

async function registerClient(
  server: string,
  endpoint: string,
  redirectUri: string,
  scopes: string[],
  auth: OAuthConfig,
  redirectPort: number,
): Promise<StoredClient> {
  const body: Record<string, unknown> = {
    client_name: auth.clientName ?? "ollama-agent",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (scopes.length > 0) body.scope = scopes.join(" ");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Dynamic client registration failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Registration endpoint returned invalid JSON.");
  }
  if (typeof payload.client_id !== "string" || !payload.client_id) {
    throw new Error("Registration response is missing client_id.");
  }

  const stored: StoredClient = {
    clientId: payload.client_id,
    clientSecret:
      typeof payload.client_secret === "string" ? payload.client_secret : undefined,
    redirectPort,
    registeredAt: new Date().toISOString(),
  };
  const store = await readClientStore();
  store[server] = stored;
  await writeClientStore(store);
  return stored;
}

/**
 * Resolve explicit OAuth settings or discover them:
 * protected-resource metadata (RFC 9728) -> authorization-server metadata
 * (RFC 8414 / OIDC) -> dynamic client registration (RFC 7591).
 */
export async function resolveOAuthConfig(
  server: string,
  serverUrl: string,
  auth: OAuthConfig,
  options: OAuthOptions,
): Promise<ResolvedOAuthConfig> {
  const redirectPort = auth.redirectPort ?? 4318;
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;

  const hasAny = Boolean(auth.authorizationUrl || auth.tokenUrl || auth.clientId);
  const hasAll = Boolean(auth.authorizationUrl && auth.tokenUrl && auth.clientId);
  if (hasAny && !hasAll) {
    throw new Error(
      "OAuth config is incomplete: provide authorizationUrl, tokenUrl, and clientId together, or none for discovery.",
    );
  }
  if (hasAll) {
    return {
      authorizationUrl: auth.authorizationUrl as string,
      tokenUrl: auth.tokenUrl as string,
      clientId: auth.clientId as string,
      clientSecret: auth.clientSecret,
      scopes: auth.scopes ?? [],
      redirectPort,
      audience: auth.audience,
      extraAuthorizationParams: auth.extraAuthorizationParams,
    };
  }

  const resource = await discoverResourceMetadata(serverUrl, auth, options);
  const servers = stringArray(resource.data.authorization_servers);
  const issuer =
    servers?.[0] ?? new URL(serverUrl).origin;
  const authorizationServer = await discoverAuthorizationServer(issuer);

  const authorizationUrl = authorizationServer.data.authorization_endpoint;
  const tokenUrl = authorizationServer.data.token_endpoint;
  if (typeof authorizationUrl !== "string" || typeof tokenUrl !== "string") {
    throw new Error(
      "Authorization-server metadata is missing authorization_endpoint or token_endpoint.",
    );
  }

  const scopes =
    auth.scopes ??
    stringArray(resource.data.scopes_supported) ??
    stringArray(authorizationServer.data.scopes_supported) ??
    [];

  let clientId = auth.clientId;
  let clientSecret = auth.clientSecret;
  if (!clientId) {
    const stored = (await readClientStore())[server];
    if (stored && stored.redirectPort === redirectPort) {
      clientId = stored.clientId;
      clientSecret = stored.clientSecret;
    }
  }
  if (!clientId) {
    const endpoint =
      auth.registrationUrl ??
      (typeof authorizationServer.data.registration_endpoint === "string"
        ? authorizationServer.data.registration_endpoint
        : undefined);
    if (!endpoint) {
      throw new Error(
        "No clientId is configured and the authorization server does not advertise a registration_endpoint.",
      );
    }
    const registered = await registerClient(
      server,
      endpoint,
      redirectUri,
      scopes,
      auth,
      redirectPort,
    );
    clientId = registered.clientId;
    clientSecret = registered.clientSecret;
  }

  const resourceId =
    typeof resource.data.resource === "string" ? resource.data.resource : undefined;

  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    clientSecret,
    scopes,
    redirectPort,
    audience: auth.audience ?? resourceId,
    resource: resourceId,
    extraAuthorizationParams: auth.extraAuthorizationParams,
  };
}

async function tokenRequest(
  config: ResolvedOAuthConfig,
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
  config: ResolvedOAuthConfig,
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
  config: ResolvedOAuthConfig,
  options: OAuthOptions,
): Promise<OAuthToken> {
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  const port = config.redirectPort;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const callback = waitForCode(port, state, options.timeoutMs ?? 180_000);

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  if (config.audience) url.searchParams.set("audience", config.audience);
  if (config.resource) url.searchParams.set("resource", config.resource);
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
    if (config.resource) params.set("resource", config.resource);
    return await tokenRequest(config, params);
  } finally {
    callback.close();
  }
}

/** Return a cached, unexpired access token without doing discovery or I/O. */
export async function peekToken(server: string): Promise<string | undefined> {
  const existing = (await readStore())[server];
  if (!existing) return undefined;
  if (
    existing.expiresAt !== undefined &&
    existing.expiresAt - 60_000 <= Date.now()
  ) {
    return undefined;
  }
  return existing.accessToken;
}

/**
 * Return a valid access token for an MCP server, resolving OAuth metadata,
 * registering a client when needed, refreshing, or running the
 * authorization-code + PKCE flow. Tokens and registrations are stored per
 * server with mode 0600.
 */
export async function ensureToken(
  server: string,
  auth: OAuthConfig | undefined,
  options: OAuthOptions,
): Promise<string> {
  const config = auth ?? {};
  const store = await readStore();
  const existing = store[server];
  const expired =
    existing?.expiresAt !== undefined
      ? existing.expiresAt - 60_000 <= Date.now()
      : false;

  if (!options.force && existing && !expired) return existing.accessToken;

  const resolved = await resolveOAuthConfig(
    server,
    options.serverUrl,
    config,
    options,
  );

  if (existing?.refreshToken && (expired || options.force)) {
    try {
      const refreshed = await refresh(resolved, existing);
      store[server] = refreshed;
      await writeStore(store);
      return refreshed.accessToken;
    } catch {
      // Fall through to the interactive flow.
    }
  }

  const token = await authorize(resolved, options);
  store[server] = token;
  await writeStore(store);
  return token.accessToken;
}
