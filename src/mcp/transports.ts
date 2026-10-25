import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Error carrying the HTTP status and headers for OAuth discovery. */
export class HttpTransportError extends Error {
  status: number;
  headers: Headers;

  constructor(status: number, statusText: string, body: string, headers: Headers) {
    super(`MCP HTTP ${status} ${statusText}: ${body}`);
    this.name = "HttpTransportError";
    this.status = status;
    this.headers = headers;
  }
}

export interface TransportOptions {
  onMessage: (message: unknown) => void;
  onError: (error: Error) => void;
  onLog?: (line: string) => void;
}

/** newline-delimited JSON over a child process's stdio. */
export class StdioTransport {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private closing = false;

  constructor(
    config: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    },
    options: TransportOptions,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (!line) continue;
        try {
          options.onMessage(JSON.parse(line));
        } catch {
          // Servers occasionally log to stdout; ignore non-JSON lines.
          options.onLog?.(line);
        }
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) options.onLog?.(text);
    });

    this.child.on("error", (error) => options.onError(error));
    this.child.on("exit", (code, signal) => {
      if (this.closing) return;
      options.onError(
        new Error(
          `MCP server exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}).`,
        ),
      );
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.closing || this.child.stdin.destroyed) {
      throw new Error("MCP stdio transport is closed.");
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.child.exitCode !== null) return;
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // ignore
        }
        resolve();
      }, 500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * MCP Streamable HTTP transport: POST JSON-RPC messages and consume either a
 * JSON response or an SSE stream. Session ids are echoed back via
 * Mcp-Session-Id, as the transport requires.
 */
export class HttpTransport {
  private url: string;
  private headers: Record<string, string>;
  private sessionId?: string;
  private options: TransportOptions;
  private closing = false;

  constructor(
    config: { url: string; headers?: Record<string, string> },
    options: TransportOptions,
  ) {
    this.url = config.url;
    this.headers = config.headers ?? {};
    this.options = options;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  async send(message: unknown): Promise<void> {
    if (this.closing) throw new Error("MCP HTTP transport is closed.");
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new HttpTransportError(
        response.status,
        response.statusText,
        body,
        response.headers,
      );
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      // Read the stream in the background: it may stay open, but responses
      // arrive as they are produced.
      void this.consumeSse(response);
      return;
    }

    const text = await response.text();
    if (!text.trim()) return;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.options.onMessage(JSON.parse(line));
      } catch {
        this.options.onLog?.(line);
      }
    }
  }

  private async consumeSse(response: Response): Promise<void> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            this.options.onMessage(JSON.parse(data));
          } catch {
            this.options.onLog?.(data);
          }
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      reader.releaseLock();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: this.requestHeaders(),
      });
    } catch {
      // best effort
    }
  }
}
