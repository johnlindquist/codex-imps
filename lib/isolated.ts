/**
 * Shared helper for creating fully isolated Codex SDK agents.
 *
 * Default mode is streaming (shows all events as they happen).
 * Use --quiet for buffered one-shot output.
 */

import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { mkdirSync, symlinkSync, existsSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { clientAvailable, runViaDaemon, runDaemon } from "./daemon.ts";

export interface ProfileConfig {
  name: string;
  model?: string;
  reasoningEffort?: string;
  baseInstructions: string;
  developerInstructions: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  extraEnv?: Record<string, string>;
}

export function createIsolatedCodex(config: ProfileConfig) {
  const realHome = process.env.HOME!;
  const isolatedHome = `/tmp/codex-profile-${config.name}-${process.pid}`;
  mkdirSync(isolatedHome, { recursive: true });

  const authSrc = `${realHome}/.codex/auth.json`;
  const authDst = `${isolatedHome}/auth.json`;
  if (existsSync(authSrc) && !existsSync(authDst)) {
    symlinkSync(authSrc, authDst);
  }

  const model = config.model || process.env.CODEX_PROFILE_MODEL || "gpt-5.3-codex-spark";

  const codex = new Codex({
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: realHome,
      CODEX_HOME: isolatedHome,
      ...config.extraEnv,
    },
    config: {
      base_instructions: config.baseInstructions,
      developer_instructions: config.developerInstructions,
      model_reasoning_effort: config.reasoningEffort || "low",
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
        plugins: false,
        hooks: false,
        memories: false,
        apps: false,
        image_generation: false,
        tool_search: false,
        tool_suggest: false,
      },
    },
  });

  const startThread = (overrides?: Partial<ThreadOptions>) =>
    codex.startThread({
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: config.sandboxMode || "danger-full-access",
      approvalPolicy: "never",
      ...overrides,
    });

  const cleanup = () => {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {}
  };

  return { codex, startThread, cleanup, model, isolatedHome };
}

function buildInteractiveFlags(config: ProfileConfig): string[] {
  const model = config.model || process.env.CODEX_PROFILE_MODEL || "gpt-5.3-codex-spark";
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "--disable", "plugins",
    "--disable", "hooks",
    "--disable", "memories",
    "--disable", "apps",
    "--disable", "image_generation",
    "--disable", "tool_search",
    "--disable", "tool_suggest",
    "-c", "skills.include_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_environment_context=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_permissions_instructions=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "memories.use_memories=false",
    "-c", "mcp_servers={}",
    "-c", 'web_search="disabled"',
    "-c", `model_reasoning_effort="${config.reasoningEffort || "low"}"`,
    "-m", model,
  ];
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const interactive = args.includes("-i") || args.includes("--interactive");
  const quiet = args.includes("-q") || args.includes("--quiet");
  const help = args.includes("--help") || args.includes("-h");
  const daemon = args.includes("--daemon");
  const noWarm = args.includes("--no-warm");
  // --effort <none|minimal|low|medium|high|xhigh>: per-turn reasoning override (warm daemon path)
  const effortIdx = args.findIndex((a) => a === "--effort");
  const effort = effortIdx !== -1 ? args[effortIdx + 1] : undefined;
  const flags = ["-q", "--quiet", "-i", "--interactive", "--help", "-h", "--daemon", "--no-warm"];
  const prompt = args
    .filter((a, i) => !flags.includes(a) && a !== "--effort" && i !== effortIdx + 1)
    .join(" ");
  return { interactive, quiet, help, daemon, noWarm, effort, prompt, noArgs: args.length === 0 };
}

// Renders streaming app-server JSON-RPC notifications (warm daemon path).
// Answer tokens stream to stdout; reasoning/commands/output go to stderr.
function renderAppServerNotif(method: string, params: any) {
  switch (method) {
    case "item/agentMessage/delta":
      process.stdout.write(params?.delta ?? "");
      break;
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      process.stderr.write(`\x1b[2;3m${params?.delta ?? ""}\x1b[0m`);
      break;
    case "item/started":
      if (params?.item?.type === "commandExecution") {
        process.stderr.write(`\x1b[2m$ ${params.item.command}\x1b[0m\n`);
      }
      break;
    case "item/commandExecution/outputDelta":
      if (params?.delta) process.stderr.write(`\x1b[2m${params.delta}\x1b[0m`);
      break;
    case "item/completed":
      if (params?.item?.type === "commandExecution" && params.item.exitCode && params.item.exitCode !== 0) {
        process.stderr.write(`\x1b[31m→ exit ${params.item.exitCode}\x1b[0m\n`);
      }
      break;
    case "turn/plan/updated":
      if (Array.isArray(params?.plan)) {
        for (const step of params.plan) {
          const mark = step.status === "completed" ? "✓" : "○";
          process.stderr.write(`\x1b[2m  ${mark} ${step.step ?? step.text ?? ""}\x1b[0m\n`);
        }
      }
      break;
  }
}

function renderEvent(event: any) {
  if (event.type === "item.started") {
    const item = event.item;
    if (item.type === "command_execution") {
      process.stderr.write(`\x1b[2m$ ${item.command}\x1b[0m\n`);
    }
  } else if (event.type === "item.completed") {
    const item = event.item;
    if (item.type === "agent_message") {
      console.log(item.text);
    } else if (item.type === "command_execution") {
      if (item.aggregated_output) {
        process.stderr.write(`\x1b[2m${item.aggregated_output}\x1b[0m`);
        if (!item.aggregated_output.endsWith("\n")) process.stderr.write("\n");
      }
      if (item.exit_code !== 0) {
        process.stderr.write(`\x1b[31m→ exit ${item.exit_code}\x1b[0m\n`);
      }
    } else if (item.type === "reasoning" && item.text) {
      process.stderr.write(`\x1b[2;3m${item.text}\x1b[0m\n`);
    } else if (item.type === "todo_list") {
      for (const todo of item.items) {
        const mark = todo.completed ? "✓" : "○";
        process.stderr.write(`\x1b[2m  ${mark} ${todo.text}\x1b[0m\n`);
      }
    }
  }
}

export async function runProfile(config: ProfileConfig) {
  const { interactive, quiet, help, daemon, noWarm, effort, prompt, noArgs } = parseArgs(process.argv);

  if (help || noArgs) {
    console.log(`${config.name} — isolated codex agent (spark)

Usage:
  ${config.name} <prompt>            Run with streaming (default)
  ${config.name} -q <prompt>         Quiet mode (buffered, final answer only)
  ${config.name} -i [prompt]         Interactive TUI in new cmux pane
  ${config.name} --daemon            Start warm daemon (auto-used by next ${config.name} call)
  ${config.name} --no-warm <prompt>  Force in-process (skip daemon even if running)
  ${config.name} --effort <level>    Reasoning effort: none|minimal|low|medium|high|xhigh (warm daemon)
  ${config.name} --help              Show this help`);
    process.exit(0);
  }

  if (daemon) {
    await runDaemon(config);
    return;
  }

  if (interactive) {
    const devInstructions = tomlEscape(config.developerInstructions);
    const flags = buildInteractiveFlags(config);

    const launcherPath = `/tmp/${config.name}-launcher-${process.pid}.sh`;
    const launcherContent = [
      "#!/bin/sh",
      `cd ${JSON.stringify(process.cwd())}`,
      [
        "exec codex",
        ...flags.map((f) => JSON.stringify(f)),
        "-c", `'developer_instructions="${devInstructions}"'`,
        "--skip-git-repo-check",
      ].join(" "),
    ].join("\n");
    writeFileSync(launcherPath, launcherContent, { mode: 0o755 });

    try {
      const result = execSync("cmux new-pane --focus true", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const match = result.match(/surface:(\d+)/);
      const surfaceRef = match ? `surface:${match[1]}` : undefined;
      if (surfaceRef) {
        execSync(`cmux send --surface ${surfaceRef} "${launcherPath}\n"`, {
          encoding: "utf-8",
          timeout: 5000,
        });
        console.log(`Opened interactive codex in ${surfaceRef}`);
      } else {
        console.error("Failed to parse cmux surface ref from:", result);
        process.exit(1);
      }
    } catch (e: any) {
      console.error("Failed to open cmux pane:", e.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!prompt) {
    console.error(`${config.name}: no prompt provided (use -i for interactive mode)`);
    process.exit(1);
  }

  const ac = new AbortController();

  // If a warm daemon is listening, route through it — skips process spawn +
  // auth/config load + WebSocket prewarm (paid once at daemon start).
  if (!noWarm && clientAvailable(config.name)) {
    const onSignal = () => { ac.abort(); process.exit(130); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let streamedAnswer = false;
    try {
      await runViaDaemon(
        config.name,
        { prompt, quiet, cwd: process.cwd(), effort },
        {
          onNotification: (method, params) => {
            if (method === "item/agentMessage/delta") streamedAnswer = true;
            renderAppServerNotif(method, params);
          },
          onFinal: (text) => {
            // In streaming mode the answer already printed via deltas; just close the line.
            if (streamedAnswer) process.stdout.write("\n");
            else if (text) console.log(text);
          },
          onError: (message) => { process.stderr.write(`\x1b[31mdaemon error: ${message}\x1b[0m\n`); },
        },
        ac.signal,
      );
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }

  const { startThread, cleanup } = createIsolatedCodex(config);
  const onSignal = () => { ac.abort(); cleanup(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const thread = startThread();

  try {
    if (quiet) {
      const turn = await thread.run(prompt, { signal: ac.signal });
      if (turn.finalResponse) console.log(turn.finalResponse);
    } else {
      const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
      for await (const event of events) renderEvent(event);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}
