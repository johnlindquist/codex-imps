import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { homedir } from "os";

export type EvolutionSeverity = "low" | "medium" | "high";
export type EvolutionState = "pending" | "applied" | "dismissed";

export interface EvolutionSuggestion {
  schema: 1;
  id: string;
  imp: string;
  thread_id?: string;
  turn_id?: string;
  transcript_path?: string;
  event_log_path?: string;
  created_at: string;
  score: number;
  benchmark: number;
  severity: EvolutionSeverity;
  dedupe_key: string;
  recommendation: string;
  evidence: string[];
  new_imp_candidate: null | {
    name: string;
    rationale: string;
  };
  state: EvolutionState;
}

export interface EvolutionTelemetry {
  imp: string;
  prompt: string;
  finalText?: string;
  threadId?: string;
  turnId?: string;
  transport: string;
  status: string;
  startedAt: string;
  completedAt: string;
  events: unknown[];
}

export interface EvolutionObserver {
  onAppServerNotification(method: string, params: any): void;
  onSdkEvent(event: any): void;
  finish(extra: { status: string; transport: string; finalText?: string; threadId?: string; turnId?: string }): void;
}

export function impHome(): string {
  return process.env.IMP_HOME || join(homedir(), ".imp");
}

export function evolutionFilePath(imp: string): string {
  return join(impHome(), `${imp}.evolutions.jsonl`);
}

export function statusFilePath(imp: string): string {
  return join(impHome(), `${imp}.status.json`);
}

export function sessionLogPath(id: string): string {
  return join(impHome(), "sessions", `${id}.jsonl`);
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

function stableHash(parts: unknown[]): string {
  return createHash("sha256")
    .update(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function suggestionId(suggestion: Pick<EvolutionSuggestion, "imp" | "dedupe_key" | "created_at">): string {
  return `evo_${stableHash([suggestion.imp, suggestion.dedupe_key, suggestion.created_at])}`;
}

export function readEvolutionSuggestions(imp: string): EvolutionSuggestion[] {
  const file = evolutionFilePath(imp);
  if (!existsSync(file)) return [];
  const out: EvolutionSuggestion[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.schema === 1 && value?.imp === imp) out.push(value);
    } catch {}
  }
  return out;
}

export function pendingEvolutionCount(imp: string): number {
  return readEvolutionSuggestions(imp).filter((s) => s.state === "pending").length;
}

export function appendEvolutionSuggestion(suggestion: EvolutionSuggestion): boolean {
  const file = evolutionFilePath(suggestion.imp);
  const existing = readEvolutionSuggestions(suggestion.imp);
  if (existing.some((s) => s.dedupe_key === suggestion.dedupe_key && s.state === "pending")) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(suggestion) + "\n", "utf8");
  writeEvolutionStatus(suggestion.imp);
  return true;
}

export function writeSessionLog(telemetry: EvolutionTelemetry): string {
  const id = telemetry.threadId || telemetry.turnId || stableHash([telemetry.imp, telemetry.startedAt, telemetry.prompt]);
  const file = sessionLogPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const rows = [
    { type: "session", ...telemetry, prompt: redactSecrets(telemetry.prompt), finalText: redactSecrets(telemetry.finalText || "") },
    ...telemetry.events.map((event) => ({ type: "event", event })),
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return file;
}

export function makeEvolutionSuggestion(input: {
  imp: string;
  prompt: string;
  finalText?: string;
  status: string;
  transport: string;
  threadId?: string;
  turnId?: string;
  eventLogPath?: string;
  now?: Date;
}): EvolutionSuggestion | null {
  const finalText = (input.finalText || "").trim();
  const evidence: string[] = [];
  let score = 90;
  let recommendation = "";

  if (input.status !== "completed") {
    score -= 35;
    evidence.push(`turn ended with status ${input.status}`);
    recommendation = "Review this imp's runtime boundary and prompt expectations; the session did not complete cleanly.";
  }
  if (!finalText) {
    score -= 30;
    evidence.push("session produced no final assistant text");
    recommendation = "Tighten the imp's output rule so it always reports a final result or explicit blocker.";
  }

  if (evidence.length === 0) return null;

  const created_at = (input.now || new Date()).toISOString();
  const dedupe_key = stableHash([input.imp, input.status, evidence, input.prompt.slice(0, 240)]);
  const severity: EvolutionSeverity = score < 40 ? "high" : score < 70 ? "medium" : "low";
  const suggestion: EvolutionSuggestion = {
    schema: 1,
    id: "",
    imp: input.imp,
    thread_id: input.threadId,
    turn_id: input.turnId,
    event_log_path: input.eventLogPath,
    created_at,
    score,
    benchmark: 85,
    severity,
    dedupe_key,
    recommendation,
    evidence: evidence.map(redactSecrets),
    new_imp_candidate: null,
    state: "pending",
  };
  suggestion.id = suggestionId(suggestion);
  return suggestion;
}

function compactEvent(event: unknown): unknown {
  const json = JSON.stringify(event);
  if (json.length <= 4_000) return event;
  return { truncated: true, preview: redactSecrets(json.slice(0, 4_000)) };
}

export function createEvolutionObserver(config: { name: string }, prompt: string): EvolutionObserver {
  const disabled = process.env.IMP_EVOLUTION_DISABLED === "1";
  const events: unknown[] = [];
  const startedAt = new Date();
  let finalText = "";
  let threadId: string | undefined;
  let turnId: string | undefined;

  const push = (event: unknown) => {
    if (disabled || events.length >= 200) return;
    events.push(compactEvent(event));
  };

  return {
    onAppServerNotification(method: string, params: any) {
      if (disabled) return;
      try {
        if (method === "item/agentMessage/delta") finalText += params?.delta ?? "";
        if (method === "item/completed" && params?.item?.type === "agentMessage" && params.item.text) {
          finalText = params.item.text;
        }
        if (method === "turn/started") {
          threadId = params?.threadId ?? params?.thread_id ?? params?.thread?.id ?? threadId;
          turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? turnId;
        }
        if (method === "turn/completed") {
          threadId = params?.threadId ?? params?.thread_id ?? threadId;
          turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? turnId;
        }
        push({ method, params });
      } catch {}
    },
    onSdkEvent(event: any) {
      if (disabled) return;
      try {
        if (event?.type === "item.completed" && event?.item?.type === "agent_message" && event.item.text) {
          finalText = event.item.text;
        }
        if (event?.type === "turn.started") {
          threadId = event.thread_id ?? event.threadId ?? threadId;
          turnId = event.turn?.id ?? event.turn_id ?? event.turnId ?? turnId;
        }
        if (event?.type === "turn.completed") {
          threadId = event.thread_id ?? event.threadId ?? threadId;
          turnId = event.turn?.id ?? event.turn_id ?? event.turnId ?? turnId;
        }
        push(event);
      } catch {}
    },
    finish(extra) {
      if (disabled) return;
      try {
        const completedAt = new Date();
        const effectiveFinalText = extra.finalText ?? finalText;
        const telemetry: EvolutionTelemetry = {
          imp: config.name,
          prompt,
          finalText: effectiveFinalText,
          threadId: extra.threadId ?? threadId,
          turnId: extra.turnId ?? turnId,
          transport: extra.transport,
          status: extra.status,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          events,
        };
        const eventLogPath = writeSessionLog(telemetry);
        const suggestion = makeEvolutionSuggestion({
          imp: config.name,
          prompt,
          finalText: effectiveFinalText,
          status: extra.status,
          transport: extra.transport,
          threadId: telemetry.threadId,
          turnId: telemetry.turnId,
          eventLogPath,
          now: completedAt,
        });
        if (suggestion) appendEvolutionSuggestion(suggestion);
        else writeEvolutionStatus(config.name);
      } catch {}
    },
  };
}

export function writeEvolutionStatus(imp: string): void {
  const suggestions = readEvolutionSuggestions(imp);
  const pending = suggestions.filter((s) => s.state === "pending");
  const status = {
    schema: 1,
    imp,
    updated_at: new Date().toISOString(),
    pending: pending.length,
    high_severity_pending: pending.filter((s) => s.severity === "high").length,
  };
  const file = statusFilePath(imp);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(status, null, 2) + "\n", "utf8");
}

export function evolutionStatusLine(imp: string): string | undefined {
  const pending = pendingEvolutionCount(imp);
  if (pending === 0) return undefined;
  return `🔁 ${pending} evolution${pending === 1 ? "" : "s"} pending`;
}
