#!/usr/bin/env bun
/**
 * imps — manage the fleet of codex imps.
 *
 *   imps list                     roster: every imp, warm status, lesson count
 *   imps ps                       warm imps only: pid, uptime, idle timeout
 *   imps stop <name>|--all        stop warm imp(s)
 *   imps lessons [name]           lesson counts, or one imp's lessons in detail
 *   imps lessons <name> --prune [--days N]   age out old lessons now
 *   imps lessons <name> --promote            print Error-recovery candidates
 *   imps lessons <name> --clear               delete the lessons file
 *   imps doctor                   environment sanity checks
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { metaPath, readMeta, socketPath, stopWarmImp, tryConnect } from "./lib/imp.ts";
import { parseLessons, pruneExpiredLessons } from "./lib/self-improve.ts";

const IMPS_DIR = join(import.meta.dir, "imps");

function roster(): string[] {
  return readdirSync(IMPS_DIR)
    .filter((f) => /^imp-[a-z0-9-]+$/.test(f))
    .sort();
}

function lessonsPath(name: string): string {
  return join(IMPS_DIR, `${name}.lessons.md`);
}

function lessonCount(name: string): number {
  const p = lessonsPath(name);
  if (!existsSync(p)) return 0;
  return parseLessons(readFileSync(p, "utf8")).length;
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
  console.log(`${"IMP".padEnd(pad)}WARM   LESSONS`);
  for (const name of names) {
    const warm = (await isWarm(name)) ? "yes" : "-";
    const lessons = lessonCount(name) || "-";
    console.log(`${name.padEnd(pad)}${String(warm).padEnd(7)}${lessons}`);
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

function cmdLessons(name?: string, flags: string[] = []): void {
  if (!name) {
    let any = false;
    for (const imp of roster()) {
      const count = lessonCount(imp);
      if (count > 0) {
        console.log(`${imp.padEnd(24)}${count} lesson${count === 1 ? "" : "s"}   (${lessonsPath(imp)})`);
        any = true;
      }
    }
    if (!any) console.log("no imp has recorded lessons");
    return;
  }

  const p = lessonsPath(name);
  if (!existsSync(p)) {
    console.log(`${name} has no lessons file (${p})`);
    return;
  }
  const content = readFileSync(p, "utf8");
  const lessons = parseLessons(content);

  if (flags.includes("--clear")) {
    unlinkSync(p);
    console.log(`cleared ${lessons.length} lesson(s): deleted ${p}`);
    return;
  }

  if (flags.includes("--prune")) {
    const daysIdx = flags.indexOf("--days");
    const days = daysIdx !== -1 ? Number(flags[daysIdx + 1]) : 30;
    const pruned = pruneExpiredLessons(content, days);
    if (pruned === content) {
      console.log(`nothing to prune (${lessons.length} lesson(s) within ${days} days)`);
      return;
    }
    if (pruned.trim()) writeFileSync(p, pruned, "utf8");
    else unlinkSync(p);
    const kept = pruned.trim() ? parseLessons(pruned).length : 0;
    console.log(`pruned ${lessons.length - kept} lesson(s), kept ${kept}`);
    return;
  }

  if (flags.includes("--promote")) {
    if (lessons.length === 0) {
      console.log("no lessons to promote");
      return;
    }
    console.log(`Paste-ready candidates for the "## Error recovery" section of imps/${name}`);
    console.log(`(fill in the FIX command, then delete the graduated lesson with --prune/--clear):\n`);
    for (const l of lessons) {
      const evidence = (l.evidence ?? "").slice(0, 70).trim() || `failure of ${l.command ?? "a command"}`;
      const from = [l.command && `\`${l.command}\``, l.category && `[${l.category}]`, l.date].filter(Boolean).join(" ") || "a legacy lesson";
      console.log(`"${evidence}" -> YOUR_FIX_COMMAND_HERE   # graduated from ${from}`);
    }
    return;
  }

  console.log(`${name}: ${lessons.length} lesson(s) in ${p}\n`);
  for (const l of lessons) {
    console.log(`  ${l.date ?? "undated"}  [${l.category ?? "?"}]  ${l.command ?? "(no command)"}`);
    if (l.evidence) console.log(`      evidence: ${l.evidence.slice(0, 100)}`);
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
  case "lessons":
    cmdLessons(rest.find((a) => !a.startsWith("--")), rest.filter((a) => a.startsWith("--") || /^\d+$/.test(a)));
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default:
    console.log(`imps — manage the fleet of codex imps

Usage:
  imps [list]                    roster: every imp, warm status, lesson count
  imps ps                        warm imps: pid, uptime, idle timeout
  imps stop <name>|--all         stop warm imp(s)
  imps lessons [name]            lesson counts, or one imp's lessons
  imps lessons <name> --prune [--days N]   age out old lessons
  imps lessons <name> --promote  print Error-recovery candidates to graduate
  imps lessons <name> --clear    delete the lessons file
  imps doctor                    environment sanity checks`);
    process.exit(cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
}
