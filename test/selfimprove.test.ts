import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  applySelfImproveOverlay,
  capAtLessonBoundary,
  classifyFailure,
  createSelfImproveObserver,
  isExpectedNonzero,
  lessonFor,
  parseLessons,
  pruneExpiredLessons,
  recordLessons,
  redactSecrets,
  resolveSelfImprove,
  scanTranscript,
  signature,
} from "../lib/self-improve.ts";
import { applyLessonOverlay, hooksEnabled, prepareIsolatedCodexHome } from "../lib/codex-runtime.ts";
import type { ImpConfig } from "../lib/isolated.ts";

const HANDLER = join(import.meta.dir, "..", "lib", "self-improve-stop.ts");
const roots: string[] = [];
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), "selfimprove-"));
  roots.push(r);
  return r;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ---- pure failure scanning --------------------------------------------------

test("scanTranscript detects a non-zero exit code", () => {
  const jsonl =
    JSON.stringify({ payload: { type: "local_shell_call", command: "nope_12345", exit_code: 127, stderr: "command not found" } }) +
    "\n" +
    JSON.stringify({ payload: { type: "local_shell_call", command: "ls", exit_code: 0 } });
  const failures = scanTranscript(jsonl);
  expect(failures.length).toBe(1);
  expect(failures[0].kind).toBe("nonzero-exit");
  expect(failures[0].exit).toBe(127);
  expect(failures[0].command).toBe("nope_12345");
});

test("scanTranscript detects failed status and error fields", () => {
  const jsonl =
    JSON.stringify({ item: { status: "failed", command: "deploy" } }) +
    "\n" +
    JSON.stringify({ result: { error: "boom: bad config" } });
  const kinds = scanTranscript(jsonl).map((f) => f.kind).sort();
  expect(kinds).toContain("failed-status");
  expect(kinds).toContain("error-field");
});

test("a clean transcript yields no failures and writes nothing", () => {
  const jsonl =
    JSON.stringify({ payload: { type: "local_shell_call", command: "ls", exit_code: 0, status: "completed" } }) +
    "\n" +
    JSON.stringify({ payload: { type: "agent_message", text: "the error rate dropped" } }); // 'error' substring, not a key
  expect(scanTranscript(jsonl)).toEqual([]);
  const root = tmp();
  const lessons = join(root, "x.lessons.md");
  expect(recordLessons(lessons, [])).toBe(0);
  expect(existsSync(lessons)).toBe(false);
});

test("classifyFailure maps failures to actionable categories", () => {
  expect(classifyFailure({ kind: "nonzero-exit", path: "$", exit: 127, message: "zsh: command not found: nope" })).toBe("command-not-found");
  expect(classifyFailure({ kind: "nonzero-exit", path: "$", exit: 2, message: "error: unknown flag --frop\nusage: tool ..." })).toBe("usage-error");
  expect(classifyFailure({ kind: "nonzero-exit", path: "$", exit: 1, message: "cat: /tmp/nope: No such file or directory" })).toBe("missing-path");
  expect(classifyFailure({ kind: "nonzero-exit", path: "$", exit: 126, message: "permission denied" })).toBe("permission-denied");
  expect(classifyFailure({ kind: "nonzero-exit", path: "$", exit: 124, message: "command timed out" })).toBe("timeout");
  expect(classifyFailure({ kind: "error-field", path: "$", message: "connect ECONNREFUSED 127.0.0.1:5432" })).toBe("connection-error");
  expect(classifyFailure({ kind: "failed-status", path: "$", status: "failed" })).toBe("generic");
});

test("lessons include the category and category-specific advice", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  recordLessons(lessons, [
    { kind: "nonzero-exit", path: "$", exit: 2, command: "cmux frop", message: "Unknown command: frop" },
  ]);
  const body = readFileSync(lessons, "utf8");
  expect(body).toContain("[usage-error]");
  expect(body).toContain("cmux frop");
  expect(body).toContain("--help");
});

test("expected nonzero exits from query commands are not recorded", () => {
  expect(isExpectedNonzero({ kind: "nonzero-exit", path: "$", exit: 1, command: "rg TODO src/" })).toBe(true);
  expect(isExpectedNonzero({ kind: "nonzero-exit", path: "$", exit: 1, command: "/bin/zsh -lc 'grep -q foo file.txt'" })).toBe(true);
  expect(isExpectedNonzero({ kind: "nonzero-exit", path: "$", exit: 1, command: "test -f /tmp/x" })).toBe(true);
  expect(isExpectedNonzero({ kind: "nonzero-exit", path: "$", exit: 2, command: "rg --frop" })).toBe(false);
  expect(isExpectedNonzero({ kind: "nonzero-exit", path: "$", exit: 1, command: "npm test" })).toBe(false);

  const root = tmp();
  const lessons = join(root, "noise.lessons.md");
  expect(recordLessons(lessons, [{ kind: "nonzero-exit", path: "$", exit: 1, command: "rg TODO" }])).toBe(0);
  expect(existsSync(lessons)).toBe(false);
});

test("signature ignores volatile later lines of output", () => {
  const a = { kind: "nonzero-exit" as const, path: "$", exit: 2, command: "tool x", message: "usage: tool\nat 2026-01-01T00:00:00Z pid 123" };
  const b = { kind: "nonzero-exit" as const, path: "$", exit: 2, command: "tool x", message: "usage: tool\nat 2026-06-10T09:30:00Z pid 999" };
  expect(signature(a)).toBe(signature(b));
});

test("capAtLessonBoundary cuts at a lesson marker, not mid-lesson", () => {
  const lesson = (n: number) => `<!-- selfimprove:${String(n).padStart(16, "0")} -->\n- [generic] lesson ${n} ${"x".repeat(80)}\n`;
  const body = [1, 2, 3, 4].map(lesson).join("\n");
  const capped = capAtLessonBoundary(body, 250);
  expect(capped.length).toBeLessThanOrEqual(250);
  expect(capped.startsWith("<!-- selfimprove:")).toBe(true);
  expect(capAtLessonBoundary(body, body.length + 10)).toBe(body);
});

test("parseLessons extracts sig, date, category, command, evidence", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  recordLessons(lessons, [
    { kind: "nonzero-exit", path: "$", exit: 2, command: "tool --bad", message: "usage: tool [options]" },
  ]);
  const parsed = parseLessons(readFileSync(lessons, "utf8"));
  expect(parsed.length).toBe(1);
  expect(parsed[0].sig).toMatch(/^[0-9a-f]{16}$/);
  expect(parsed[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(parsed[0].category).toBe("usage-error");
  expect(parsed[0].command).toBe("tool --bad");
  expect(parsed[0].evidence).toContain("usage: tool");
});

test("pruneExpiredLessons drops old and undated lessons, keeps fresh ones", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-06-10T12:00:00Z");
  const fresh = lessonFor({ kind: "nonzero-exit", path: "$", exit: 2, command: "fresh-cmd", message: "usage:" }, 1200, now - 5 * day);
  const stale = lessonFor({ kind: "nonzero-exit", path: "$", exit: 2, command: "stale-cmd", message: "usage:" }, 1200, now - 90 * day);
  const legacy = "\n<!-- selfimprove:aaaaaaaaaaaaaaaa -->\n- [generic] Command `legacy-cmd` exited 1. Old advice.\n";
  const content = stale + legacy + fresh;

  const pruned = pruneExpiredLessons(content, 30, now);
  expect(pruned).toContain("fresh-cmd");
  expect(pruned).not.toContain("stale-cmd");
  expect(pruned).not.toContain("legacy-cmd");

  // maxAgeDays 0 disables aging entirely.
  expect(pruneExpiredLessons(content, 0, now)).toBe(content);
});

test("recordLessons prunes expired lessons when appending new ones", () => {
  const root = tmp();
  const lessons = join(root, "aging.lessons.md");
  const now = Date.now();
  writeFileSync(lessons, lessonFor({ kind: "nonzero-exit", path: "$", exit: 2, command: "ancient-cmd", message: "usage:" }, 1200, now - 90 * 86_400_000));
  recordLessons(lessons, [{ kind: "nonzero-exit", path: "$", exit: 127, command: "new-cmd", message: "command not found" }]);
  const body = readFileSync(lessons, "utf8");
  expect(body).toContain("new-cmd");
  expect(body).not.toContain("ancient-cmd");
});

test("recordLessons dedupes by signature across calls", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  const failures = scanTranscript(JSON.stringify({ payload: { command: "boom", exit_code: 2 } }));
  expect(recordLessons(lessons, failures)).toBe(1);
  // Same failure again → no new lesson appended.
  expect(recordLessons(lessons, failures)).toBe(0);
  const body = readFileSync(lessons, "utf8");
  expect(body).toContain(`selfimprove:${signature(failures[0])}`);
  expect(body.match(/selfimprove:/g)?.length).toBe(1);
});

test("recordLessons redacts common secrets before rendering", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  recordLessons(lessons, [
    {
      kind: "nonzero-exit",
      path: "$.payload.exit_code",
      exit: 1,
      command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456'",
      message: "failed with ghp_abcdefghijklmnopqrstuvwxyz123456",
    },
  ]);
  const body = readFileSync(lessons, "utf8");
  expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  expect(body).toContain("[REDACTED");
  expect(redactSecrets("AWS_SECRET_ACCESS_KEY=abcdef")).toContain("[REDACTED]");
});

// ---- prepareIsolatedCodexHome wiring ---------------------------------------

function cfg(over: Partial<ImpConfig> = {}): ImpConfig {
  return { name: "imp-selfimprove", baseInstructions: "base", developerInstructions: "dev", ...over };
}

test("self-improvement is enabled by default and can be explicitly disabled", () => {
  expect(hooksEnabled(cfg())).toBe(false);
  expect(hooksEnabled(cfg({ selfImprove: { enabled: true } }))).toBe(false);
  expect(resolveSelfImprove(cfg()).enabled).toBe(true);
  expect(resolveSelfImprove(cfg({ selfImprove: { enabled: false } })).enabled).toBe(false);
  expect(resolveSelfImprove(cfg({ selfImprove: { enabled: true } })).enabled).toBe(true);
  expect(resolveSelfImprove(cfg({ name: "imp-gh" }), { CODEX_IMP_SELF_IMPROVE: "imp-gh" }).enabled).toBe(true);
});

test("prepareIsolatedCodexHome wires Stop hook only when explicitly enabled", () => {
  const root = tmp();
  const home = join(root, "codex-home");
  const lessons = join(root, "imp-selfimprove.lessons.md");
  const runtime = prepareIsolatedCodexHome(cfg({ selfImprove: { enabled: true, lessonsPath: lessons, stopHook: true } }), home, root);

  expect(runtime.hooksEnabled).toBe(true);
  expect(runtime.extraEnv.CODEX_IMP_LESSONS_PATH).toBe(lessons);
  expect(runtime.extraEnv.CODEX_IMP_NAME).toBe("imp-selfimprove");
  expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("bypass_hook_trust = true");
  const hooksJson = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  expect(hooksJson.hooks.Stop[0].hooks[0].type).toBe("command");
  expect(hooksJson.hooks.Stop[0].hooks[0].command).toContain("self-improve-stop.ts");
  expect(existsSync(join(home, "hooks", "self-improve-stop.ts"))).toBe(true);
  expect(existsSync(lessons)).toBe(false); // no empty sidecar is seeded
});

test("prepareIsolatedCodexHome exposes env but no hook config for imp-side self-improvement", () => {
  const root = tmp();
  const home = join(root, "codex-home");
  const lessons = join(root, "imp-selfimprove.lessons.md");
  const runtime = prepareIsolatedCodexHome(cfg({ selfImprove: { enabled: true, lessonsPath: lessons } }), home, root);

  expect(runtime.hooksEnabled).toBe(false);
  expect(runtime.extraEnv.CODEX_IMP_LESSONS_PATH).toBe(lessons);
  expect(existsSync(join(home, "hooks.json"))).toBe(false);
  expect(existsSync(join(home, "config.toml"))).toBe(false);
  expect(existsSync(lessons)).toBe(false);
});

test("prepareIsolatedCodexHome writes no hook config or env when explicitly disabled", () => {
  const root = tmp();
  const home = join(root, "codex-home");
  const runtime = prepareIsolatedCodexHome(cfg({ selfImprove: { enabled: false } }), home, root);
  expect(runtime.hooksEnabled).toBe(false);
  expect(runtime.extraEnv).toEqual({});
  expect(existsSync(join(home, "hooks.json"))).toBe(false);
  expect(existsSync(join(home, "config.toml"))).toBe(false);
});

test("applyLessonOverlay is a no-op when explicitly disabled or lessons file is empty", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  writeFileSync(lessons, "- ignored while disabled\n");
  expect(applyLessonOverlay(cfg({ selfImprove: { enabled: false, lessonsPath: lessons } })).developerInstructions).toBe("dev");

  writeFileSync(lessons, "");
  expect(applySelfImproveOverlay(cfg({ selfImprove: { lessonsPath: lessons } })).developerInstructions).toBe("dev");
});

test("applyLessonOverlay appends lessons once, idempotently", () => {
  const root = tmp();
  const lessons = join(root, "p.lessons.md");
  writeFileSync(lessons, "- always check exit codes\n");
  const c = cfg({ selfImprove: { enabled: true, lessonsPath: lessons } });
  const once = applyLessonOverlay(c);
  expect(once.developerInstructions).toContain("Self-improvement lessons");
  expect(once.developerInstructions).toContain("always check exit codes");
  // Re-applying the already-overlaid config is a no-op (no duplicate heading).
  const twice = applyLessonOverlay(once);
  expect(twice.developerInstructions).toBe(once.developerInstructions);
});

test("imp-side observer records app-server and SDK command failures", () => {
  const root = tmp();
  const lessons = join(root, "observer.lessons.md");
  const c = cfg({ selfImprove: { enabled: true, lessonsPath: lessons } });
  const observer = createSelfImproveObserver(c);
  observer.onAppServerNotification("item/completed", {
    item: { type: "commandExecution", command: "bad-appserver", exitCode: 2, aggregatedOutput: "usage: nope" },
  });
  observer.onSdkEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "bad-sdk", exit_code: 3, aggregated_output: "command not found" },
  });
  expect(observer.finish({ status: "completed" })).toBe(2);
  const body = readFileSync(lessons, "utf8");
  expect(body).toContain("bad-appserver");
  expect(body).toContain("bad-sdk");
});

// ---- end-to-end: run the real handler binary --------------------------------

function runHandler(input: object, env: Record<string, string>) {
  return spawnSync("bun", [HANDLER], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("handler appends a lesson for a synthetic failed Stop transcript", () => {
  const root = tmp();
  const lessons = join(root, "imp-selfimprove.lessons.md");
  const transcript = join(root, "rollout.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { type: "local_shell_call", command: "no_such_command_12345", exit_code: 127, stderr: "command not found" },
    }) + "\n",
  );
  const res = runHandler(
    {
      hook_event_name: "Stop",
      transcript_path: transcript,
      stop_hook_active: false,
      session_id: "s",
      turn_id: "t",
      cwd: root,
      model: "gpt-test",
      permission_mode: "bypassPermissions",
      last_assistant_message: "done",
    },
    { CODEX_IMP_LESSONS_PATH: lessons },
  );
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('"continue":true');
  const body = readFileSync(lessons, "utf8");
  expect(body).toContain("[command-not-found]");
  expect(body).toContain("exited 127");
});

test("handler is a no-op when stop_hook_active (recursion guard)", () => {
  const root = tmp();
  const lessons = join(root, "l.lessons.md");
  const transcript = join(root, "r.jsonl");
  writeFileSync(transcript, JSON.stringify({ payload: { command: "x", exit_code: 1 } }) + "\n");
  const res = runHandler(
    { hook_event_name: "Stop", transcript_path: transcript, stop_hook_active: true },
    { CODEX_IMP_LESSONS_PATH: lessons },
  );
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('"continue":true');
  expect(existsSync(lessons)).toBe(false); // nothing written
});

test("handler ignores non-Stop events", () => {
  const root = tmp();
  const lessons = join(root, "l.lessons.md");
  const res = runHandler(
    { hook_event_name: "SessionStart", source: "startup" },
    { CODEX_IMP_LESSONS_PATH: lessons },
  );
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('"continue":true');
  expect(existsSync(lessons)).toBe(false);
});
