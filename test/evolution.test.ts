import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendEvolutionSuggestion,
  evolutionFilePath,
  evolutionStatusLine,
  makeEvolutionSuggestion,
  pendingEvolutionCount,
  readEvolutionSuggestions,
  redactSecrets,
  statusFilePath,
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
  expect(evolutionStatusLine("imp-test")).toBe("🔁 1 evolution pending");
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

test("suggestions are written under IMP_HOME", () => {
  const file = evolutionFilePath("imp-test");
  expect(file.startsWith(root)).toBe(true);
});
