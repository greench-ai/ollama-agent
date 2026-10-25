// Minimal JSON-RPC 2.0 connection used by the MCP transports.
// Messages are correlated by id; server-initiated requests are answered with a
// small default set (ping, roots/list) and rejected otherwise.

export class JsonRpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type SendMessage = (message: unknown) => Promise<void>;

export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private send: SendMessage;
  private onNotification?: (method: string, params: unknown) => void;
  private closed = false;

  constructor(
    send: SendMessage,
    options: { onNotification?: (method: string, params: unknown) => void } = {},
  ) {
    this.send = send;
    this.onNotification = options.onNotification;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("MCP connection is closed."));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    await this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };

    // Response to something we sent.
    if (message.id !== undefined && message.method === undefined) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // Notification from the server.
    if (message.method !== undefined && message.id === undefined) {
      this.onNotification?.(message.method, message.params);
      return;
    }

    // Request from the server; answer minimally.
    if (message.method !== undefined && message.id !== undefined) {
      void this.answerServerRequest(message.id, message.method, message.params);
    }
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      switch (method) {
        case "ping":
          await this.send({ jsonrpc: "2.0", id, result: {} });
          return;
        case "roots/list":
          await this.send({ jsonrpc: "2.0", id, result: { roots: [] } });
          return;
        case "sampling/createMessage":
        case "elicitation/create":
        case "completion/complete":
          await this.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unsupported client method: ${method}` },
          });
          return;
        default:
          await this.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
          void params;
      }
    } catch {
      // The transport is going away; nothing useful to do.
    }
  }

  /** Reject every pending request and stop accepting new ones. */
  fail(reason: string): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
