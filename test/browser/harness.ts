/**
 * Shared harness for the browser tests.
 *
 * Serves `web/` over HTTP and stubs the API, so a test can drive the real
 * client code without a model or a backend. The static server matters: the
 * client uses ES modules and `fetch`, which `file://` URLs do not support.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

// harness.ts lives in test/browser/, so the repo root is two levels up.
export const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Server-sent events used to fake a streaming turn. */
export type SseEvent = [event: string, data: Record<string, unknown>];

export function sseBody(events: SseEvent[], done: Record<string, unknown> = {}): string {
  const lines: string[] = [];
  for (const [event, data] of events) {
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push("");
  }
  lines.push("event: done");
  lines.push(`data: ${JSON.stringify(done)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export interface HarnessOptions {
  /** Bodies keyed by API path prefix, e.g. { "/api/chat": sseBody(...) }. */
  routes?: Record<string, () => string | Promise<string>>;
}

export interface Harness {
  page: Page;
  /** Console/page errors collected since load. */
  errors: string[];
  close(): Promise<void>;
}

/**
 * Launch a browser against the static client.
 *
 * API calls are intercepted with Playwright routing rather than served, so each
 * test controls the exact bytes the client sees.
 */
export async function openApp(options: HarnessOptions = {}): Promise<Harness> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(WEB_ROOT, path.normalize(relative).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(path.normalize(WEB_ROOT))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        // The client is loaded as a module; keep it simple and same-origin.
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 900, height: 420 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // Playwright resolves routes in reverse registration order, so the broad
  // catch-all must be registered FIRST for the specific handlers below to win.
  // Any unhandled API call then gets an empty object instead of a 404.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // Defaults so the shell boots without a backend.
  await page.route("**/api/state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "mock:latest",
        cwd: WEB_ROOT,
        version: "test",
        settings: { showThinking: true, theme: "system" },
        permissionMode: "default",
      }),
    }),
  );
  await page.route("**/api/sessions*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    }),
  );
  for (const [prefix, handler] of Object.entries(options.routes ?? {})) {
    await page.route(`**${prefix}*`, async (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
        body: await handler(),
      }),
    );
  }

  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForLoadState("networkidle");

  return {
    page,
    errors,
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Submit the composer and wait for a turn to finish. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.fill("#input", text);
  await page.evaluate(`(() => {
    const form = document.getElementById("composer");
    form.requestSubmit();
  })()`);
  await page.waitForFunction(
    "() => (window.__agentTurns || 0) >= 1",
    undefined,
    { timeout: 15_000 },
  );
}

/** Ordered description of the children of the last assistant message. */
export async function assistantBlocks(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    const nodes = document.querySelectorAll('.msg.assistant');
    const msg = nodes[nodes.length - 1];
    if (!msg) return [];
    return [...msg.children].map((node) => {
      if (node.classList.contains("tool")) {
        const name = node.querySelector(".name");
        return "tool:" + (name ? name.textContent : "");
      }
      if (node.classList.contains("thinking")) return "thinking";
      if (node.classList.contains("md")) {
        const text = (node.textContent || "").trim();
        return "text:" + (text || "(empty)");
      }
      if (node.classList.contains("msg-actions")) return "actions";
      return "other:" + node.className;
    });
  })()`);
}
