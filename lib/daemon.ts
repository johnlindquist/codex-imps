/**
 * Daemon mode: keeps a profile "warm" so client invocations skip
 * bun startup + SDK import + CODEX_HOME setup (~500ms savings).
 *
 * Protocol: newline-delimited JSON over a Unix socket at
 *   /tmp/codex-profile-{name}.sock
 *
 * Client -> Daemon (one line):
 *   { "prompt": "...", "quiet": false, "cwd": "/abs/path" }
 *
 * Daemon -> Client (many lines, then close):
 *   { "type": "event", "event": <SDK event> }
 *   { "type": "final", "text": "..." }              (quiet mode only)
 *   { "type": "error", "message": "..." }
 *   { "type": "done" }
 */

import { createServer, createConnection, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import { createIsolatedCodex, type ProfileConfig } from "./isolated.ts";

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

  const { codex, cleanup } = createIsolatedCodex(config);
  console.error(`${config.name} daemon ready at ${sock} (pid ${process.pid})`);

  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let req: { prompt: string; quiet?: boolean; cwd?: string };
      try {
        req = JSON.parse(line);
      } catch (e: any) {
        socket.write(JSON.stringify({ type: "error", message: `bad json: ${e.message}` }) + "\n");
        socket.end();
        return;
      }

      const thread = codex.startThread({
        workingDirectory: req.cwd || process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode: config.sandboxMode || "danger-full-access",
        approvalPolicy: "never",
      });

      const send = (obj: unknown) => socket.write(JSON.stringify(obj) + "\n");

      try {
        if (req.quiet) {
          const turn = await thread.run(req.prompt);
          send({ type: "final", text: turn.finalResponse || "" });
        } else {
          const { events } = await thread.runStreamed(req.prompt);
          for await (const event of events) {
            send({ type: "event", event });
          }
        }
        send({ type: "done" });
      } catch (e: any) {
        send({ type: "error", message: e.message || String(e) });
      } finally {
        socket.end();
      }
    });
    socket.on("error", () => {});
  });

  server.listen(sock);

  const shutdown = () => {
    server.close();
    try { unlinkSync(sock); } catch {}
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {}); // wait forever
}

export interface ClientEventHandlers {
  onEvent?: (event: any) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

export function clientAvailable(name: string): boolean {
  return existsSync(socketPath(name));
}

export async function runViaDaemon(
  name: string,
  req: { prompt: string; quiet: boolean; cwd: string },
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
        if (msg.type === "event") handlers.onEvent?.(msg.event);
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
