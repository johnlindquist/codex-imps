import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendEvolutionSuggestion,
  appendStabilization,
  enqueueEvolutionJob,
  evaluateTelemetry,
  evolutionFilePath,
  evolutionStatusLine,
  evolutionTriggerPath,
  refreshEvolutionTrigger,
  makeEvolutionSuggestion,
  pendingEvolutionCount,
  readEvolutionSuggestions,
  readEvolutionTrigger,
  readStabilizations,
  redactSecrets,
  statusFilePath,
  updateEvolutionSuggestionState,
  writeSessionLog,
  type EvolutionTelemetry,
} from "../lib/evolution.ts";

const root = mkdtempSync(join(tmpdir(), "evolution-"));
const oldImpHome = process.env.IMP_HOME;

beforeEach(() => {
  process.env.IMP_HOME = root;
});

afterAll(() => {
  if (oldImpHome === undefined) delete process.env.IMP_HOME;
  else process.env.IMP_HOME = oldImpHome;
  rmSync(root, { recursive: true, force: true });
});

test("clean completed sessions do not create suggestions", () => {
  expect(
    makeEvolutionSuggestion({
      imp: "imp-test",
      prompt: "say hi",
      finalText: "hi",
      status: "completed",
      transport: "test",
    }),
  ).toBeNull();
});

test("empty final answer creates a pending suggestion", () => {
  const suggestion = makeEvolutionSuggestion({
    imp: "imp-test",
    prompt: "do the thing",
    finalText: "",
    status: "completed",
    transport: "test",
    now: new Date("2026-06-18T12:00:00Z"),
  });
  expect(suggestion).not.toBeNull();
  expect(suggestion!.state).toBe("pending");
  expect(suggestion!.recommendation).toContain("final result");
  expect(appendEvolutionSuggestion(suggestion!)).toBe(true);
  expect(pendingEvolutionCount("imp-test")).toBe(1);
  expect(evolutionStatusLine("imp-test")).toContain("🔁 1 evolution pending");
  expect(existsSync(statusFilePath("imp-test"))).toBe(true);
});

test("dedupes pending suggestions by stable key", () => {
  const a = makeEvolutionSuggestion({
    imp: "imp-dupe",
    prompt: "same prompt",
    finalText: "",
    status: "completed",
    transport: "test",
    now: new Date("2026-06-18T12:00:00Z"),
  })!;
  const b = makeEvolutionSuggestion({
    imp: "imp-dupe",
    prompt: "same prompt",
    finalText: "",
    status: "completed",
    transport: "test",
    now: new Date("2026-06-18T12:01:00Z"),
  })!;
  expect(a.dedupe_key).toBe(b.dedupe_key);
  expect(appendEvolutionSuggestion(a)).toBe(true);
  expect(appendEvolutionSuggestion(b)).toBe(false);
  expect(readEvolutionSuggestions("imp-dupe").length).toBe(1);
});

test("redacts common secrets before persistence", () => {
  expect(redactSecrets("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  const telemetry: EvolutionTelemetry = {
    imp: "imp-redact",
    prompt: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    finalText: "AWS_SECRET_ACCESS_KEY=abcdef",
    threadId: "thread-redact",
    transport: "test",
    status: "completed",
    startedAt: "2026-06-18T12:00:00Z",
    completedAt: "2026-06-18T12:00:01Z",
    events: [],
  };
  const file = writeSessionLog(telemetry);
  const body = readFileSync(file, "utf8");
  expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  expect(body).not.toContain("AWS_SECRET_ACCESS_KEY=abcdef");
});

test("clean telemetry records a stabilization summary", () => {
  const telemetry: EvolutionTelemetry = {
    imp: "imp-stable",
    prompt: "say hi",
    finalText: "hi",
    threadId: "thread-stable",
    turnId: "turn-stable",
    transport: "test",
    status: "completed",
    startedAt: "2026-06-18T12:00:00Z",
    completedAt: "2026-06-18T12:00:01Z",
    events: [],
  };
  const file = writeSessionLog(telemetry);
  const result = evaluateTelemetry(telemetry, file, new Date("2026-06-18T12:00:02Z"));
  expect("summary" in result).toBe(true);
  expect(appendStabilization(result as any)).toBe(true);
  expect(readStabilizations("imp-stable").length).toBe(1);
  expect(evolutionStatusLine("imp-stable")).toContain("★★★★★");
});

test("enqueueEvolutionJob writes a durable queue file", () => {
  const job = enqueueEvolutionJob("imp-queue", "/tmp/session.jsonl", new Date("2026-06-18T12:00:00Z"));
  expect(job.id).toStartWith("job_");
  expect(readFileSync(join(root, "evolution-queue", `${job.id}.json`), "utf8")).toContain("/tmp/session.jsonl");
});

test("three pending suggestions create an automatic evolution trigger", () => {
  for (let i = 0; i < 3; i++) {
    const suggestion = makeEvolutionSuggestion({
      imp: "imp-threshold",
      prompt: `prompt ${i}`,
      finalText: "",
      status: "completed",
      transport: "test",
      now: new Date(`2026-06-18T12:0${i}:00Z`),
    })!;
    expect(appendEvolutionSuggestion(suggestion)).toBe(true);
  }

  const trigger = refreshEvolutionTrigger("imp-threshold");
  expect(trigger?.pending).toBe(3);
  expect(trigger?.command).toBe("imp evolve imp-threshold");
  expect(readEvolutionTrigger("imp-threshold")?.reason).toContain("automatic threshold");
  expect(readFileSync(evolutionTriggerPath("imp-threshold"), "utf8")).toContain("imp evolve imp-threshold");
  expect(evolutionStatusLine("imp-threshold")).toContain("auto-evolution ready");
});

test("reviewed suggestions stop counting as pending", () => {
  const first = makeEvolutionSuggestion({
    imp: "imp-review",
    prompt: "first",
    finalText: "",
    status: "completed",
    transport: "test",
    now: new Date("2026-06-18T12:00:00Z"),
  })!;
  const second = makeEvolutionSuggestion({
    imp: "imp-review",
    prompt: "second",
    finalText: "",
    status: "completed",
    transport: "test",
    now: new Date("2026-06-18T12:01:00Z"),
  })!;
  appendEvolutionSuggestion(first);
  appendEvolutionSuggestion(second);

  expect(updateEvolutionSuggestionState("imp-review", [first.id], "applied")).toBe(1);
  expect(updateEvolutionSuggestionState("imp-review", ["all"], "dismissed")).toBe(1);
  expect(pendingEvolutionCount("imp-review")).toBe(0);
  expect(readEvolutionSuggestions("imp-review").map((s) => s.state)).toEqual(["applied", "dismissed"]);
});

test("suggestions are written under IMP_HOME", () => {
  const file = evolutionFilePath("imp-test");
  expect(file.startsWith(root)).toBe(true);
});
