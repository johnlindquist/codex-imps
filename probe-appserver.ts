#!/usr/bin/env bun
/**
 * App-server TTFT probe.
 *
 * Launches ONE persistent `codex app-server` process (NDJSON JSON-RPC over stdio),
 * does initialize + threadStart ONCE, then measures time-to-first-token for:
 *   - turn1:  first turn on a fresh thread (warm process, cold connection → prewarm runs here)
 *   - turn2:  second turn on the SAME thread (warm process + warm connection + history)
 *   - turn3:  first turn on a NEW thread in the same warm process (warm process, no history)
 *
 * "First token" = first of these notifications after turnStart:
 *   item/started, item/reasoning/textDelta, item/reasoning/summaryTextDelta, item/agentMessage/delta
 *
 * Compare against the cold baseline: `bun bench.ts imp-gh "say hi" --runs 8`.
 */

import { spawn } from "child_process";
import { mkdirSync, symlinkSync, existsSync, rmSync } from "fs";

const realHome = process.env.HOME!;
const isolatedHome = `/tmp/codex-appserver-probe-${process.pid}`;
mkdirSync(isolatedHome, { recursive: true });
const authSrc = `${realHome}/.codex/auth.json`;
if (existsSync(authSrc) && !existsSync(`${isolatedHome}/auth.json`)) {
  symlinkSync(authSrc, `${isolatedHome}/auth.json`);
}

const MODEL = "gpt-5.5";

// Same isolation config as lib/isolated.ts, passed via ThreadStartParams.config
const isolationConfig: Record<string, unknown> = {
  model_reasoning_effort: "medium",
  show_raw_agent_reasoning: true,
  skills: { include_instructions: false },
  include_apps_instructions: false,
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
  include_permissions_instructions: false,
  project_doc_max_bytes: 0,
  memories: { use_memories: false },
  mcp_servers: {},
  web_search: "disabled",
  features: {
    plugins: false, hooks: false, memories: false, apps: false,
    image_generation: false, tool_search: false, tool_suggest: false,
  },
};

const BASE_INSTRUCTIONS =
  "You are imp-gh, a gh-only agent. Every user message is a gh task. First step: run gh via exec_command; never give a text-only plan.";
const DEV_INSTRUCTIONS = "You are imp-gh, a gh-only agent.\n\n## Operating rule\nRun gh via exec_command before any final answer.";

const child = spawn("codex", ["app-server"], {
  env: {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: realHome,
    CODEX_HOME: isolatedHome,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (c) => { stderrBuf += c.toString(); });

// ---- NDJSON plumbing -------------------------------------------------------
type Handler = (msg: any) => void;
const handlers = new Set<Handler>();
let rbuf = "";
child.stdout.on("data", (chunk) => {
  rbuf += chunk.toString("utf8");
  let nl;
  while ((nl = rbuf.indexOf("\n")) !== -1) {
    const line = rbuf.slice(0, nl);
    rbuf = rbuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    for (const h of [...handlers]) h(msg);
  }
});

let nextId = 1;
function send(method: string, params?: unknown): number {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}
function notify(method: string, params?: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function awaitResponse(id: number, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { handlers.delete(h); reject(new Error(`timeout waiting for id ${id}\nstderr:\n${stderrBuf.slice(-2000)}`)); }, timeoutMs);
    const h: Handler = (msg) => {
      if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
        clearTimeout(t); handlers.delete(h);
        if (msg.error) reject(new Error(`rpc error id ${id}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    };
    handlers.add(h);
  });
}

// First protocol frame for the turn (envelope — arrives instantly on a hot connection)
const FIRST_FRAME_METHODS = new Set(["item/started", "turn/started"]);
// First actual model CONTENT token (reasoning or visible answer)
const FIRST_CONTENT_METHODS = new Set([
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/agentMessage/delta",
]);

/** Run a turn; measure first frame, first content token, and total from turnStart send. */
function runTurn(threadId: string, text: string, effort = "low"): Promise<{ frame: number; content: number; total: number; contentMethod: string; sample: string }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let firstFrame: number | null = null;
    let firstContent: number | null = null;
    let contentMethod = "";
    let sample = "";
    const t = setTimeout(() => { handlers.delete(h); reject(new Error(`turn timeout\nstderr:\n${stderrBuf.slice(-2000)}`)); }, 90000);
    const h: Handler = (msg) => {
      if (!msg.method) return;
      if (firstFrame === null && FIRST_FRAME_METHODS.has(msg.method)) firstFrame = performance.now();
      if (firstContent === null && FIRST_CONTENT_METHODS.has(msg.method)) {
        firstContent = performance.now();
        contentMethod = msg.method;
      }
      if (msg.method === "item/agentMessage/delta" && sample.length < 60) {
        sample += msg.params?.delta ?? msg.params?.text ?? "";
      }
      if (msg.method === "turn/completed") {
        clearTimeout(t); handlers.delete(h);
        const total = performance.now() - start;
        resolve({
          frame: firstFrame !== null ? firstFrame - start : total,
          content: firstContent !== null ? firstContent - start : total,
          total, contentMethod, sample: sample.replace(/\n/g, " ").slice(0, 60),
        });
      }
    };
    handlers.add(h);
    send("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      effort,
    });
  });
}

async function startThread(): Promise<string> {
  const id = send("thread/start", {
    model: MODEL,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    baseInstructions: BASE_INSTRUCTIONS,
    developerInstructions: DEV_INSTRUCTIONS,
    ephemeral: true,
    config: isolationConfig,
  });
  const res = await awaitResponse(id);
  // ThreadStartResponse carries the thread id; tolerate field-name variants
  return res.thread_id || res.threadId || res.thread?.id || res.id;
}

// ---- Sequence --------------------------------------------------------------
async function main() {
  const tSpawn = performance.now();

  const initId = send("initialize", {
    clientInfo: { name: "ttft-probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  await awaitResponse(initId);
  notify("initialized");
  const tInit = performance.now();

  const thread1 = await startThread();
  const tThread = performance.now();

  console.log(`setup: spawn→initialize=${(tInit - tSpawn).toFixed(0)}ms  threadStart=${(tThread - tInit).toFixed(0)}ms  (paid ONCE, before user prompt)`);
  const fmt = (label: string, r: any) =>
    console.log(`${label}  frame=${r.frame.toFixed(0)}ms  content=${r.content.toFixed(0)}ms  total=${r.total.toFixed(0)}ms  via=${r.contentMethod || "(none)"}  reply="${r.sample}"`);

  // Several fresh-thread turns in the warm process — this is the stateless CLI-replacement pattern
  for (let i = 0; i < 3; i++) {
    const th = i === 0 ? thread1 : await startThread();
    fmt(`freshThread #${i + 1} (warm process):`, await runTurn(th, "say hi"));
  }
  // effort=none on a fresh thread — "just run it" mode
  fmt(`freshThread effort=none:        `, await runTurn(await startThread(), "say hi", "none"));

  child.kill("SIGTERM");
  rmSync(isolatedHome, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  child.kill("SIGTERM");
  rmSync(isolatedHome, { recursive: true, force: true });
  process.exit(1);
});
