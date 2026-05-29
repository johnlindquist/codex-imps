/**
 * Warm daemon: holds ONE persistent `codex app-server` process alive (via
 * AppServerClient) so each invocation skips process spawn + auth/config load +
 * WebSocket connect/prewarm. Measured: ~2s for a short answer vs ~5.4s cold,
 * with the first protocol frame back in ~1ms.
 *
 * Protocol: newline-delimited JSON over a Unix socket at
 *   /tmp/codex-profile-{name}.sock
 *
 * Client -> Daemon (one line):
 *   { "prompt": "...", "quiet": false, "cwd": "/abs/path", "effort": "low" }
 *
 * Daemon -> Client (many lines, then close):
 *   { "type": "notif", "method": "...", "params": {...} }   (streaming, non-quiet)
 *   { "type": "final", "text": "..." }                      (always, on completion)
 *   { "type": "error", "message": "..." }
 *   { "type": "done" }
 */

import { createServer, createConnection, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import type { ProfileConfig } from "./isolated.ts";
import { AppServerClient } from "./appserver.ts";

export function socketPath(name: string): string {
  return `/tmp/codex-profile-${name}.sock`;
}

export async function runDaemon(config: ProfileConfig): Promise<void> {
  const sock = socketPath(config.name);
  if (existsSync(sock)) {
    // Probe — if no one's listening, remove stale socket
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(sock);
        probe.once("connect", () => { probe.end(); reject(new Error("alive")); });
        probe.once("error", () => resolve());
      });
      unlinkSync(sock);
    } catch {
      console.error(`${config.name} daemon already running at ${sock}`);
      process.exit(1);
    }
  }

  const client = new AppServerClient(config);
  await client.start();
  console.error(`${config.name} daemon ready at ${sock} (pid ${process.pid}, app-server warm)`);

  // Requests are serialized: one warm app-server, one turn at a time.
  let chain: Promise<void> = Promise.resolve();

  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let req: { prompt: string; quiet?: boolean; cwd?: string; effort?: string };
      try {
        req = JSON.parse(line);
      } catch (e: any) {
        socket.write(JSON.stringify({ type: "error", message: `bad json: ${e.message}` }) + "\n");
        socket.end();
        return;
      }

      const send = (obj: unknown) => socket.write(JSON.stringify(obj) + "\n");

      chain = chain.then(async () => {
        try {
          const finalText = await client.runTurn(
            req.prompt,
            {
              onNotification: (method, params) => {
                if (!req.quiet) send({ type: "notif", method, params });
              },
            },
            { cwd: req.cwd, effort: req.effort },
          );
          send({ type: "final", text: finalText });
          send({ type: "done" });
        } catch (e: any) {
          send({ type: "error", message: e.message || String(e) });
        } finally {
          socket.end();
        }
      });
    });
    socket.on("error", () => {});
  });

  server.listen(sock);

  const shutdown = () => {
    server.close();
    try { unlinkSync(sock); } catch {}
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {}); // wait forever
}

export interface ClientEventHandlers {
  onNotification?: (method: string, params: any) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

export function clientAvailable(name: string): boolean {
  return existsSync(socketPath(name));
}

/** Try to open the daemon socket; resolves true only if a live listener accepts. */
function tryConnect(sock: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(sock);
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Ensure a warm daemon is running and reachable for this profile, auto-starting
 * one in the background if needed. This makes warm mode the DEFAULT: the first
 * call pays the startup cost once, then every later call routes through the
 * persistent app-server for instant responses. Returns true if a live daemon is
 * reachable, false if startup failed (caller should fall back to a cold run).
 */
export async function ensureDaemon(config: ProfileConfig, readyTimeoutMs = 30000): Promise<boolean> {
  const sock = socketPath(config.name);

  // Already warm and accepting connections?
  if (existsSync(sock) && (await tryConnect(sock, 500))) return true;

  // Spawn a detached background daemon: re-run THIS executable with --daemon.
  // It cleans up any stale socket on start, then listens once the app-server is warm.
  try {
    const child = spawn(process.argv[0], [process.argv[1], "--daemon"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    return false;
  }

  // Poll until the daemon accepts connections (= app-server warm) or we give up.
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnect(sock, 500)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function runViaDaemon(
  name: string,
  req: { prompt: string; quiet: boolean; cwd: string; effort?: string },
  handlers: ClientEventHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const sock = socketPath(name);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(sock);
    let buf = "";

    const onAbort = () => { socket.destroy(); reject(new Error("aborted")); };
    if (signal) signal.addEventListener("abort", onAbort);

    socket.once("connect", () => {
      socket.write(JSON.stringify(req) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "notif") handlers.onNotification?.(msg.method, msg.params);
        else if (msg.type === "final") handlers.onFinal?.(msg.text);
        else if (msg.type === "error") handlers.onError?.(msg.message);
      }
    });
    socket.once("end", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    });
    socket.once("error", (e) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
