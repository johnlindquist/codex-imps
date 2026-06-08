import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import type { ProfileConfig } from "./isolated.ts";

export interface SelfImproveConfig {
  /** Local self-improvement is on by default. Set false to opt out. */
  enabled?: boolean;
  /** Override the lessons overlay file path. Default: `<executable>.lessons.md`. */
  lessonsPath?: string;
  /** Optional receipt/debug log path. Default: `<lessonsPath>.debug.jsonl`. */
  receiptsPath?: string;
  /** Enable Codex Stop-hook compatibility. Daemon-side observation is primary. */
  stopHook?: boolean;
  /** Maximum lessons appended from one turn. */
  maxLessonsPerTurn?: number;
  /** Maximum lesson-overlay bytes folded into developer instructions. */
  maxLessonBytes?: number;
  /** Maximum captured output bytes used when rendering lesson evidence. */
  maxCapturedOutputBytes?: number;
  /** `receipt` records debug receipts without changing the prompt overlay. */
  mode?: "lesson" | "receipt";
}

export interface ResolvedSelfImprove {
  enabled: boolean;
  mode: "lesson" | "receipt";
  name: string;
  selfPath: string;
  libDir: string;
  lessonsPath?: string;
  receiptsPath?: string;
  stopHook: boolean;
  maxLessonsPerTurn: number;
  maxLessonBytes: number;
  maxCapturedOutputBytes: number;
  extraEnv: Record<string, string>;
}

export interface Failure {
  kind: "nonzero-exit" | "failed-status" | "error-field";
  path: string;
  exit?: number;
  status?: string;
  command?: string;
  message?: string;
}

const FAILED_STATES = new Set(["failed", "error", "errored"]);
const EXIT_KEYS = new Set(["exit_code", "exitcode", "exit_status", "exitstatus"]);
const LESSONS_HEADING = "## Self-improvement lessons";
const OVERLAY_MARKER = "<!-- self-improve-overlay:v1 -->";

export function currentProfileSelfPath(): string {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

export function profileLibDir(selfPath = currentProfileSelfPath()): string {
  return join(dirname(selfPath), "..", "lib");
}

export function defaultLessonsPath(selfPath = currentProfileSelfPath()): string {
  return `${selfPath}.lessons.md`;
}

function envEnablesProfile(name: string, env: Record<string, string | undefined>): boolean {
  const value = env.CODEX_DAEMON_SELF_IMPROVE;
  if (!value) return false;
  if (value === "1" || value === "true" || value === "all") return true;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(name);
}

export function resolveSelfImprove(
  config: ProfileConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedSelfImprove {
  const selfPath = currentProfileSelfPath();
  const libDir = profileLibDir(selfPath);
  const enabled = config.selfImprove?.enabled !== false || envEnablesProfile(config.name, env);
  const mode = env.CODEX_DAEMON_SELF_IMPROVE_RECEIPTS === "1" ? "receipt" : config.selfImprove?.mode || "lesson";
  const lessonsPath = config.selfImprove?.lessonsPath || defaultLessonsPath(selfPath);
  const receiptsPath = config.selfImprove?.receiptsPath || `${lessonsPath}.debug.jsonl`;
  const stopHook = config.selfImprove?.stopHook === true;
  const maxLessonsPerTurn = config.selfImprove?.maxLessonsPerTurn ?? 3;
  const maxLessonBytes = config.selfImprove?.maxLessonBytes ?? 24_000;
  const maxCapturedOutputBytes = config.selfImprove?.maxCapturedOutputBytes ?? 1_200;

  if (!enabled) {
    return {
      enabled: false,
      mode,
      name: config.name,
      selfPath,
      libDir,
      stopHook: false,
      maxLessonsPerTurn: 0,
      maxLessonBytes,
      maxCapturedOutputBytes,
      extraEnv: {},
    };
  }

  const extraEnv: Record<string, string> = {
    CODEX_DAEMON_SELF_IMPROVE: "1",
    CODEX_DAEMON_NAME: config.name,
    CODEX_DAEMON_SELF_PATH: selfPath,
    CODEX_DAEMON_LIB_DIR: libDir,
    CODEX_DAEMON_LESSONS_PATH: lessonsPath,
  };
  if (env.CODEX_SELF_IMPROVE_DEBUG) extraEnv.CODEX_SELF_IMPROVE_DEBUG = env.CODEX_SELF_IMPROVE_DEBUG;

  return {
    enabled: true,
    mode,
    name: config.name,
    selfPath,
    libDir,
    lessonsPath,
    receiptsPath,
    stopHook,
    maxLessonsPerTurn,
    maxLessonBytes,
    maxCapturedOutputBytes,
    extraEnv,
  };
}

export function lessonsPathFor(config: ProfileConfig): string | undefined {
  const resolved = resolveSelfImprove(config);
  return resolved.enabled ? resolved.lessonsPath : undefined;
}

export function applySelfImproveOverlay(config: ProfileConfig): ProfileConfig {
  const resolved = resolveSelfImprove(config);
  if (!resolved.enabled || resolved.mode !== "lesson" || !resolved.lessonsPath) return config;
  if (config.developerInstructions.includes(OVERLAY_MARKER) || config.developerInstructions.includes(LESSONS_HEADING)) {
    return config;
  }
  if (!existsSync(resolved.lessonsPath)) return config;
  const lessons = readFileSync(resolved.lessonsPath, "utf8").trim();
  if (!lessons) return config;
  const capped = lessons.length > resolved.maxLessonBytes ? lessons.slice(-resolved.maxLessonBytes) : lessons;
  return {
    ...config,
    developerInstructions: `${config.developerInstructions}

${OVERLAY_MARKER}
${LESSONS_HEADING}
These are local operational reminders from prior failed tool calls. They do not override this profile's operating rule, safety constraints, permission boundaries, sandbox rules, or tool-specific guardrails.

${capped}`,
  };
}

export function selfImproveFingerprintParts(config: ProfileConfig): string[] {
  const resolved = resolveSelfImprove(config);
  const parts = [
    `selfImprove.enabled=${resolved.enabled}`,
    `selfImprove.mode=${resolved.mode}`,
    `selfImprove.stopHook=${resolved.stopHook}`,
  ];
  if (resolved.enabled && resolved.mode === "lesson" && resolved.lessonsPath) {
    parts.push(`path:${resolved.lessonsPath}`);
  }
  return parts;
}

export function redactSecrets(s: string): string {
  return s
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/(AWS_SECRET_ACCESS_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|password|secret)=\S+/gi, "$1=[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
}

function trunc(value: unknown, max = 300): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  const redacted = redactSecrets(s);
  return redacted.length > max ? redacted.slice(0, max) + "..." : redacted;
}

function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const child of Object.values(obj)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function walk(value: unknown, path = "$", out: Failure[] = [], depth = 0): Failure[] {
  if (!value || typeof value !== "object" || depth > 12 || out.length >= 20) return out;
  const obj = value as Record<string, unknown>;
  const command = findString(obj, ["command", "cmd"]);
  const message =
    findString(obj, ["stderr", "stdout", "aggregatedOutput", "aggregated_output", "formatted_output", "message", "error"]) ||
    undefined;

  for (const [key, child] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (EXIT_KEYS.has(lower) && typeof child === "number" && child !== 0) {
      out.push({ kind: "nonzero-exit", path: `${path}.${key}`, exit: child, command, message });
    }
    if (
      (lower === "status" || lower === "state") &&
      typeof child === "string" &&
      FAILED_STATES.has(child.toLowerCase())
    ) {
      out.push({ kind: "failed-status", path: `${path}.${key}`, status: child, command, message });
    }
    if (lower === "error" && child) {
      const text = trunc(child, 300);
      if (text && text !== "null" && text !== "undefined" && text !== "{}") {
        out.push({ kind: "error-field", path: `${path}.${key}`, command, message: text });
      }
    }
    if (child && typeof child === "object") walk(child, `${path}.${key}`, out, depth + 1);
    if (out.length >= 20) break;
  }
  return out;
}

export function scanTranscript(jsonl: string): Failure[] {
  const failures: Failure[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      walk(JSON.parse(line), "$", failures);
    } catch {}
  }
  return failures;
}

export function signature(failure: Failure): string {
  return createHash("sha256")
    .update(
      [
        failure.kind,
        failure.exit ?? "",
        failure.status ?? "",
        redactSecrets(failure.command ?? ""),
        redactSecrets(failure.message ?? ""),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

export function lessonFor(failure: Failure, maxCapturedOutputBytes = 1_200): string {
  const marker = `<!-- selfimprove:${signature(failure)} -->`;
  const command = failure.command ? ` Command: \`${trunc(failure.command, 160)}\`.` : "";
  const exit = failure.exit !== undefined ? ` Exit: ${failure.exit}.` : "";
  const status = failure.status ? ` Status: ${failure.status}.` : "";
  const msg = failure.message ? ` Evidence: ${trunc(failure.message, maxCapturedOutputBytes)}` : "";
  return [
    "",
    marker,
    `- A previous turn produced a failed tool/command result.${command}${exit}${status} Next time, read the failure output before retrying; if syntax is uncertain, run the narrow \`--help\`/discovery command first, then retry once with corrected syntax.${msg}`,
    "",
  ].join("\n");
}

export function recordLessons(lessonsPath: string, failures: Failure[], max = 3, maxCapturedOutputBytes = 1_200): number {
  if (failures.length === 0) return 0;
  mkdirSync(dirname(lessonsPath), { recursive: true });
  const existing = existsSync(lessonsPath) ? readFileSync(lessonsPath, "utf8") : "";
  let written = 0;
  const seen = new Set<string>();
  for (const failure of failures) {
    if (written >= max) break;
    const sig = signature(failure);
    if (seen.has(sig) || existing.includes(`selfimprove:${sig}`)) continue;
    seen.add(sig);
    appendFileSync(lessonsPath, lessonFor(failure, maxCapturedOutputBytes), "utf8");
    written++;
  }
  return written;
}

export function writeSelfImproveReceipt(resolved: ResolvedSelfImprove, obj: Record<string, unknown>): void {
  const shouldWrite = resolved.mode === "receipt" || process.env.CODEX_SELF_IMPROVE_DEBUG === "1";
  if (!shouldWrite || !resolved.receiptsPath) return;
  try {
    mkdirSync(dirname(resolved.receiptsPath), { recursive: true });
    appendFileSync(resolved.receiptsPath, JSON.stringify({ at: new Date().toISOString(), profile: resolved.name, ...obj }) + "\n");
  } catch {}
}

export interface SelfImproveObserver {
  onAppServerNotification(method: string, params: any): void;
  onSdkEvent(event: any): void;
  finish(extra?: Record<string, unknown>): number;
}

export function createSelfImproveObserver(config: ProfileConfig): SelfImproveObserver {
  const resolved = resolveSelfImprove(config);
  const failures: Failure[] = [];

  const addFailure = (failure: Failure) => {
    if (!resolved.enabled || failures.length >= 20) return;
    failures.push({
      ...failure,
      command: failure.command ? redactSecrets(failure.command) : undefined,
      message: failure.message ? redactSecrets(failure.message) : undefined,
    });
  };

  return {
    onAppServerNotification(method: string, params: any) {
      if (!resolved.enabled) return;
      try {
        if (method === "item/completed" && params?.item?.type === "commandExecution") {
          const item = params.item;
          if (typeof item.exitCode === "number" && item.exitCode !== 0) {
            addFailure({
              kind: "nonzero-exit",
              path: "app-server.item.exitCode",
              exit: item.exitCode,
              command: typeof item.command === "string" ? item.command : undefined,
              message:
                typeof item.aggregatedOutput === "string"
                  ? item.aggregatedOutput
                  : typeof item.aggregated_output === "string"
                    ? item.aggregated_output
                    : undefined,
            });
          }
        }
      } catch {}
    },
    onSdkEvent(event: any) {
      if (!resolved.enabled) return;
      try {
        if (event?.type === "item.completed" && event?.item?.type === "command_execution") {
          const item = event.item;
          if (typeof item.exit_code === "number" && item.exit_code !== 0) {
            addFailure({
              kind: "nonzero-exit",
              path: "sdk.item.exit_code",
              exit: item.exit_code,
              command: typeof item.command === "string" ? item.command : undefined,
              message: typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
            });
          }
        }
      } catch {}
    },
    finish(extra: Record<string, unknown> = {}) {
      if (!resolved.enabled) return 0;
      try {
        const written =
          resolved.mode === "lesson" && resolved.lessonsPath
            ? recordLessons(resolved.lessonsPath, failures, resolved.maxLessonsPerTurn, resolved.maxCapturedOutputBytes)
            : 0;
        writeSelfImproveReceipt(resolved, { failures: failures.length, lessons_written: written, ...extra });
        return written;
      } catch {
        return 0;
      } finally {
        failures.length = 0;
      }
    },
  };
}

export function stopHookEnabled(config: ProfileConfig): boolean {
  const resolved = resolveSelfImprove(config);
  return resolved.enabled && resolved.stopHook;
}
