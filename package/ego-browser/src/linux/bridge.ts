/**
 * Linux bridge — connects to Chrome via DevTools HTTP + WebSocket.
 * Uses raw node:http for /json so it never collides with the agent
 * helper facade that overwrites globalThis.fetch.
 */
import { request as httpRequest } from "node:http";

export interface LinuxBridgeTarget {
  send(message: string): void;
  close(): void;
}

export interface LinuxBridgeOptions {
  port?: number;
  timeoutMs?: number;
  /** Called with each raw CDP message received on the WebSocket. */
  onMessage?: (data: string) => void;
  /** Called once when the WebSocket closes or errors after connecting. */
  onClose?: () => void;
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = httpRequest(url, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function connectLinuxBridge(
  options: LinuxBridgeOptions = {},
): Promise<LinuxBridgeTarget> {
  const port = options.port ?? 9222;
  const timeoutMs = options.timeoutMs ?? 5000;

  // Connect to the BROWSER endpoint, not a page's WS: browser-level Target
  // methods (createBrowserContext, createTarget for task-space isolation)
  // are rejected on page-level connections. Flattened sessions multiplex all
  // page traffic over this one socket via sessionId.
  let wsUrl: string | undefined;
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${port}/json/version`,
    );
    wsUrl = version.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) {
    const targets = await fetchJson<Array<{ webSocketDebuggerUrl: string }>>(
      `http://127.0.0.1:${port}/json`,
    );
    wsUrl = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  }
  if (!wsUrl) {
    throw new Error(
      `No debuggable target found on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`,
    );
  }

  const ws = await connectWithTimeout(wsUrl, timeoutMs);

  ws.on("message", (data) => {
    options.onMessage?.(data.toString());
  });
  ws.on("close", () => options.onClose?.());
  ws.on("error", () => options.onClose?.());

  const send = (message: string): void => {
    if (ws.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    ws.send(message);
  };

  const close = (): void => {
    ws.close();
  };

  return { send, close };
}

async function connectWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<import("ws").WebSocket> {
  const { WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `WebSocket connection to ${url} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timer);
      // Unref the TCP socket: the bridge must not keep the CLI process alive
      // after the user script finishes (the daemon outlives us by design).
      // While the script is running, pending work holds the loop open anyway.
      (
        ws as unknown as { _socket?: { unref?: () => void } }
      )._socket?.unref?.();
      resolve(ws);
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
