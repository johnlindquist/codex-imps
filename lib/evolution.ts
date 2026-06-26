import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

export type EvolutionSeverity = "low" | "medium" | "high";
export type EvolutionState = "pending" | "applied" | "dismissed";
export type EvolutionUserSignal = "disappointed";

export interface EvolutionPromptSignal {
  modelPrompt: string;
  originalPrompt: string;
  userSignal?: EvolutionUserSignal;
  userFeedback?: string;
}

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

export interface StabilizationSummary {
  schema: 1;
  id: string;
  imp: string;
  thread_id?: string;
  turn_id?: string;
  event_log_path?: string;
  created_at: string;
  score: number;
  summary: string;
  signals: string[];
}

export interface EvolutionTrigger {
  schema: 1;
  imp: string;
  created_at: string;
  pending: number;
  threshold: number;
  evolution_file: string;
  command: string;
  reason: string;
}

export interface EvolutionJob {
  schema: 1;
  id: string;
  imp: string;
  event_log_path: string;
  created_at: string;
}

export interface EvolutionTelemetry {
  imp: string;
  prompt: string;
  originalPrompt?: string;
  userSignal?: EvolutionUserSignal;
  userFeedback?: string;
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

export function parseEvolutionPromptSignal(prompt: string): EvolutionPromptSignal {
  if (!prompt.startsWith("+")) return { modelPrompt: prompt, originalPrompt: prompt };
  const newline = prompt.search(/\r?\n/);
  if (newline === -1) {
    return {
      modelPrompt: "",
      originalPrompt: prompt,
      userSignal: "disappointed",
      userFeedback: prompt.slice(1).trim(),
    };
  }
  const line = prompt.slice(0, newline);
  const newlineLength = prompt[newline] === "\r" && prompt[newline + 1] === "\n" ? 2 : 1;
  return {
    modelPrompt: prompt.slice(newline + newlineLength).replace(/^\r?\n/, ""),
    originalPrompt: prompt,
    userSignal: "disappointed",
    userFeedback: line.slice(1).trim(),
  };
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

export function stabilizationFilePath(imp: string): string {
  return join(impHome(), `${imp}.stabilizations.jsonl`);
}

export function evolutionTriggerPath(imp: string): string {
  return join(impHome(), `${imp}.evolve-request.json`);
}

export function queueDir(): string {
  return join(impHome(), "evolution-queue");
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

export function stabilizationId(summary: Pick<StabilizationSummary, "imp" | "event_log_path" | "created_at">): string {
  return `stab_${stableHash([summary.imp, summary.event_log_path, summary.created_at])}`;
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

export function updateEvolutionSuggestionState(imp: string, ids: string[], state: EvolutionState): number {
  const file = evolutionFilePath(imp);
  const suggestions = readEvolutionSuggestions(imp);
  if (suggestions.length === 0) return 0;
  const all = ids.includes("all");
  const idSet = new Set(ids);
  let changed = 0;
  const updated = suggestions.map((suggestion) => {
    if (suggestion.state !== "pending") return suggestion;
    if (!all && !idSet.has(suggestion.id)) return suggestion;
    changed++;
    return { ...suggestion, state };
  });
  if (changed === 0) return 0;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, updated.map((suggestion) => JSON.stringify(suggestion)).join("\n") + "\n", "utf8");
  writeEvolutionStatus(imp);
  refreshEvolutionTrigger(imp);
  return changed;
}

export function readStabilizations(imp: string): StabilizationSummary[] {
  const file = stabilizationFilePath(imp);
  if (!existsSync(file)) return [];
  const out: StabilizationSummary[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.schema === 1 && value?.imp === imp) out.push(value);
    } catch {}
  }
  return out;
}

export function appendEvolutionSuggestion(suggestion: EvolutionSuggestion): boolean {
  const file = evolutionFilePath(suggestion.imp);
  const existing = readEvolutionSuggestions(suggestion.imp);
  if (existing.some((s) => s.dedupe_key === suggestion.dedupe_key && s.state === "pending")) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(suggestion) + "\n", "utf8");
  writeEvolutionStatus(suggestion.imp);
  refreshEvolutionTrigger(suggestion.imp);
  return true;
}

export function appendStabilization(summary: StabilizationSummary): boolean {
  const file = stabilizationFilePath(summary.imp);
  const existing = readStabilizations(summary.imp);
  if (existing.some((s) => s.event_log_path === summary.event_log_path)) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(summary) + "\n", "utf8");
  writeEvolutionStatus(summary.imp);
  return true;
}

export function writeSessionLog(telemetry: EvolutionTelemetry): string {
  const id = telemetry.threadId || telemetry.turnId || stableHash([telemetry.imp, telemetry.startedAt, telemetry.prompt]);
  const file = sessionLogPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const events = telemetry.events.map(compactEvent);
  const rows = [
    {
      type: "session",
      ...telemetry,
      prompt: redactSecrets(telemetry.prompt),
      originalPrompt: telemetry.originalPrompt ? redactSecrets(telemetry.originalPrompt) : undefined,
      userFeedback: telemetry.userFeedback ? redactSecrets(telemetry.userFeedback) : undefined,
      finalText: redactSecrets(telemetry.finalText || ""),
      events,
    },
    ...events.map((event) => ({ type: "event", event })),
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
  userSignal?: EvolutionUserSignal;
  userFeedback?: string;
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
  if (input.userSignal === "disappointed") {
    score -= 25;
    evidence.push(input.userFeedback
      ? `user marked this run for evolution: ${input.userFeedback}`
      : "user marked this run for evolution");
    recommendation = "Review this session for a prompt, command map, workflow, or error-recovery improvement.";
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

export function makeStabilizationSummary(input: {
  imp: string;
  status: string;
  finalText?: string;
  threadId?: string;
  turnId?: string;
  eventLogPath?: string;
  now?: Date;
}): StabilizationSummary {
  const created_at = (input.now || new Date()).toISOString();
  const summary: StabilizationSummary = {
    schema: 1,
    id: "",
    imp: input.imp,
    thread_id: input.threadId,
    turn_id: input.turnId,
    event_log_path: input.eventLogPath,
    created_at,
    score: 90,
    summary: "Session completed cleanly with a final assistant response.",
    signals: ["completed", input.finalText?.trim() ? "final-response-present" : "final-response-missing"],
  };
  summary.id = stabilizationId(summary);
  return summary;
}

export function readSessionTelemetry(eventLogPath: string): EvolutionTelemetry | undefined {
  if (!existsSync(eventLogPath)) return undefined;
  for (const line of readFileSync(eventLogPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "session") {
        const { type: _type, ...telemetry } = row;
        return telemetry;
      }
    } catch {}
  }
  return undefined;
}

export function evaluateTelemetry(telemetry: EvolutionTelemetry, eventLogPath: string, now = new Date()): EvolutionSuggestion | StabilizationSummary {
  const suggestion = makeEvolutionSuggestion({
    imp: telemetry.imp,
    prompt: telemetry.prompt,
    finalText: telemetry.finalText,
    status: telemetry.status,
    transport: telemetry.transport,
    userSignal: telemetry.userSignal,
    userFeedback: telemetry.userFeedback,
    threadId: telemetry.threadId,
    turnId: telemetry.turnId,
    eventLogPath,
    now,
  });
  if (suggestion) return suggestion;
  return makeStabilizationSummary({
    imp: telemetry.imp,
    status: telemetry.status,
    finalText: telemetry.finalText,
    threadId: telemetry.threadId,
    turnId: telemetry.turnId,
    eventLogPath,
    now,
  });
}

export function recordEvaluation(result: EvolutionSuggestion | StabilizationSummary): boolean {
  if ("recommendation" in result) return appendEvolutionSuggestion(result);
  return appendStabilization(result);
}

export function enqueueEvolutionJob(imp: string, eventLogPath: string, now = new Date()): EvolutionJob {
  const job: EvolutionJob = {
    schema: 1,
    id: `job_${stableHash([imp, eventLogPath, now.toISOString()])}`,
    imp,
    event_log_path: eventLogPath,
    created_at: now.toISOString(),
  };
  const dir = queueDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${job.id}.json`);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  renameSync(tmpPath, finalPath);
  return job;
}

export function spawnEvolutionEvaluator(job: EvolutionJob): void {
  if (process.env.IMP_EVOLUTION_DISABLED === "1" || process.env.IMP_EVOLUTION_INLINE === "1") return;
  const entry = new URL("./evolution-evaluator.ts", import.meta.url).pathname;
  try {
    const child = spawn(process.argv[0] || "bun", [entry, join(queueDir(), `${job.id}.json`)], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      env: {
        ...process.env,
        IMP_EVOLUTION_DISABLED: "1",
      },
    });
    child.unref();
  } catch {}
}

function compactEvent(event: unknown): unknown {
  const json = JSON.stringify(event);
  const redacted = redactSecrets(json);
  if (redacted.length <= 4_000) {
    try {
      return JSON.parse(redacted);
    } catch {
      return redacted;
    }
  }
  return { truncated: true, preview: redacted.slice(0, 4_000) };
}

export function createEvolutionObserver(config: { name: string }, prompt: string, signal?: Pick<EvolutionPromptSignal, "originalPrompt" | "userSignal" | "userFeedback">): EvolutionObserver {
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
          originalPrompt: signal?.originalPrompt,
          userSignal: signal?.userSignal,
          userFeedback: signal?.userFeedback,
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
        const job = enqueueEvolutionJob(config.name, eventLogPath, completedAt);
        if (process.env.IMP_EVOLUTION_INLINE === "1") {
          recordEvaluation(evaluateTelemetry(telemetry, eventLogPath, completedAt));
        } else {
          spawnEvolutionEvaluator(job);
        }
      } catch {}
    },
  };
}

export function writeEvolutionStatus(imp: string): void {
  const suggestions = readEvolutionSuggestions(imp);
  const stabilizations = readStabilizations(imp);
  const pending = suggestions.filter((s) => s.state === "pending");
  const scores = [
    ...suggestions.map((s) => s.score),
    ...stabilizations.map((s) => s.score),
  ].slice(-20);
  const avg = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 90;
  const status = {
    schema: 1,
    imp,
    updated_at: new Date().toISOString(),
    pending: pending.length,
    high_severity_pending: pending.filter((s) => s.severity === "high").length,
    average_score: avg,
    stabilizations: stabilizations.length,
  };
  const file = statusFilePath(imp);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(status, null, 2) + "\n", "utf8");
}

export function refreshEvolutionTrigger(imp: string, threshold = 3): EvolutionTrigger | undefined {
  const pending = pendingEvolutionCount(imp);
  const file = evolutionTriggerPath(imp);
  if (pending < threshold) {
    try { unlinkSync(file); } catch {}
    return undefined;
  }
  let existing: EvolutionTrigger | undefined;
  try {
    existing = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  if (existing?.schema === 1 && existing.imp === imp && existing.pending === pending && existing.threshold === threshold) {
    return existing;
  }
  const trigger: EvolutionTrigger = {
    schema: 1,
    imp,
    created_at: new Date().toISOString(),
    pending,
    threshold,
    evolution_file: evolutionFilePath(imp),
    command: `imp evolve ${imp}`,
    reason: `pending evolution suggestions reached automatic threshold (${pending}/${threshold})`,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(trigger, null, 2) + "\n", "utf8");
  return trigger;
}

export function readEvolutionTrigger(imp: string): EvolutionTrigger | undefined {
  try {
    const value = JSON.parse(readFileSync(evolutionTriggerPath(imp), "utf8"));
    return value?.schema === 1 && value?.imp === imp ? value : undefined;
  } catch {
    return undefined;
  }
}

export function evolutionStatusLine(imp: string): string | undefined {
  const pending = pendingEvolutionCount(imp);
  refreshEvolutionTrigger(imp);
  const status = readStatus(imp);
  const score = status?.average_score ?? 90;
  const stars = "★★★★★".slice(0, Math.max(1, Math.min(5, Math.round(score / 20))));
  if (pending === 0) return `${stars} | 🔁 0 evolutions pending`;
  const suffix = pending >= 3 ? " — auto-evolution ready: imp evolve " + imp : "";
  return `${stars} | 🔁 ${pending} evolution${pending === 1 ? "" : "s"} pending${suffix}`;
}

function readStatus(imp: string): { average_score?: number } | undefined {
  try {
    return JSON.parse(readFileSync(statusFilePath(imp), "utf8"));
  } catch {
    return undefined;
  }
}
