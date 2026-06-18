#!/usr/bin/env bun
/**
 * imps — manage the fleet of codex imps.
 *
 *   imps list                     roster: every imp, warm status, evolution count
 *   imps ps                       warm imps only: pid, uptime, idle timeout
 *   imps stop <name>|--all        stop warm imp(s)
 *   imps evolve [name]            pending evolution suggestions
 *   imps doctor                   environment sanity checks
 */
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { metaPath, readMeta, socketPath, stopWarmImp, tryConnect } from "./lib/imp.ts";
import { evolutionFilePath, pendingEvolutionCount, readEvolutionSuggestions } from "./lib/evolution.ts";

const IMPS_DIR = join(import.meta.dir, "imps");

function roster(): string[] {
  return readdirSync(IMPS_DIR)
    .filter((f) => /^imp-[a-z0-9-]+$/.test(f))
    .sort();
}

async function isWarm(name: string): Promise<boolean> {
  const sock = socketPath(name);
  return existsSync(sock) && (await tryConnect(sock, 300));
}

function fmtUptime(startedAt?: number): string {
  if (!startedAt) return "?";
  const mins = Math.floor((Date.now() - startedAt) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

async function cmdList(): Promise<void> {
  const names = roster();
  const pad = Math.max(...names.map((n) => n.length)) + 2;
  console.log(`${"IMP".padEnd(pad)}WARM   EVOLUTIONS`);
  for (const name of names) {
    const warm = (await isWarm(name)) ? "yes" : "-";
    const pending = pendingEvolutionCount(name) || "-";
    console.log(`${name.padEnd(pad)}${String(warm).padEnd(7)}${pending}`);
  }
}

async function cmdPs(): Promise<void> {
  const rows: string[] = [];
  for (const name of roster()) {
    if (!(await isWarm(name))) continue;
    const meta = readMeta(name);
    const idle = meta?.idleMinutes ? `${meta.idleMinutes}m idle timeout` : "no idle timeout";
    rows.push(`${name.padEnd(24)}pid ${String(meta?.pid ?? "?").padEnd(8)}up ${fmtUptime(meta?.startedAt).padEnd(8)}${idle}`);
  }
  if (rows.length === 0) {
    console.log("no warm imps");
    return;
  }
  for (const row of rows) console.log(row);
}

async function cmdStop(target?: string): Promise<void> {
  if (!target) {
    console.error("usage: imps stop <name>|--all");
    process.exit(1);
  }
  const targets = target === "--all" ? roster() : [target];
  let stopped = 0;
  for (const name of targets) {
    if (!(await isWarm(name))) continue;
    await stopWarmImp(name, readMeta(name)?.pid);
    console.log(`stopped ${name}`);
    stopped++;
  }
  if (stopped === 0) console.log(target === "--all" ? "no warm imps to stop" : `${target} is not warm`);
}

function cmdEvolve(name?: string): void {
  if (!name) {
    let any = false;
    for (const imp of roster()) {
      const count = pendingEvolutionCount(imp);
      if (count > 0) {
        console.log(`${imp.padEnd(24)}${count} pending evolution${count === 1 ? "" : "s"}   (${evolutionFilePath(imp)})`);
        any = true;
      }
    }
    if (!any) console.log("no pending imp evolutions");
    return;
  }

  const suggestions = readEvolutionSuggestions(name).filter((s) => s.state === "pending");
  if (suggestions.length === 0) {
    console.log(`${name} has no pending evolutions (${evolutionFilePath(name)})`);
    return;
  }
  console.log(`${name}: ${suggestions.length} pending evolution${suggestions.length === 1 ? "" : "s"} in ${evolutionFilePath(name)}\n`);
  for (const s of suggestions) {
    console.log(`  ${s.created_at}  score ${s.score}/${s.benchmark}  ${s.severity}`);
    console.log(`      ${s.recommendation}`);
    if (s.evidence.length > 0) console.log(`      evidence: ${s.evidence[0]}`);
  }
}

async function cmdDoctor(): Promise<void> {
  const check = (label: string, ok: boolean, hint?: string) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && hint ? `  — ${hint}` : ""}`);
    return ok;
  };
  check(`bun ${Bun.version}`, true);
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  check(
    `codex CLI ${codex.status === 0 ? codex.stdout.trim() : "missing"}`,
    codex.status === 0,
    "install @openai/codex and run codex auth login",
  );
  const auth = join(process.env.HOME!, ".codex", "auth.json");
  check(`auth.json at ${auth}`, existsSync(auth), "run codex auth login");
  const names = roster();
  check(`${names.length} imps in ${IMPS_DIR}`, names.length > 0);
  let warm = 0;
  for (const name of names) if (await isWarm(name)) warm++;
  console.log(`      ${warm} warm imp(s) right now (imps ps for details)`);
  // Stale sockets: socket file exists but nothing is listening.
  for (const name of names) {
    const sock = socketPath(name);
    if (existsSync(sock) && !(await tryConnect(sock, 300))) {
      try { unlinkSync(sock); } catch {}
      try { unlinkSync(metaPath(name)); } catch {}
      console.log(`      cleaned stale socket for ${name}`);
    }
  }
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "list":
  case undefined:
    await cmdList();
    break;
  case "ps":
    await cmdPs();
    break;
  case "stop":
    await cmdStop(rest[0]);
    break;
  case "evolve":
  case "evolutions":
    cmdEvolve(rest.find((a) => !a.startsWith("--")));
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default: {
    // Free-text prompts forward to the `imp` router — `imps "open a pane..."`
    // is a near-certain typo for `imp "..."`, so make it just work. Only
    // forward what is unmistakably a prompt (an arg with spaces, or 3+ words),
    // never a near-miss subcommand like `imps lis`.
    const free = [cmd, ...(rest ?? [])].filter((a): a is string => Boolean(a));
    const looksLikePrompt =
      free.some((a) => /\s/.test(a)) || free.filter((a) => !a.startsWith("-")).length >= 3;
    if (cmd && cmd !== "--help" && cmd !== "-h" && looksLikePrompt) {
      console.error("(not a fleet command — routing via `imp`)");
      const code = await new Promise<number>((resolve) => {
        const child = spawn(join(import.meta.dir, "imp.ts"), free, { stdio: "inherit", cwd: process.cwd() });
        child.on("exit", (c, signal) => resolve(signal ? 130 : c ?? 0));
        child.on("error", () => resolve(1));
      });
      process.exit(code);
    }
    console.log(`imps — manage the fleet of codex imps

Usage:
  imps [list]                    roster: every imp, warm status, evolution count
  imps ps                        warm imps: pid, uptime, idle timeout
  imps stop <name>|--all         stop warm imp(s)
  imps evolve [name]             pending evolution suggestions
  imps doctor                    environment sanity checks

A free-text prompt routes via the \`imp\` router: imps "what changed in git?"`);
    process.exit(cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
  }
}
