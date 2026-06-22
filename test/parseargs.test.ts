import { test, expect } from "bun:test";
import { parseArgs } from "../lib/isolated.ts";

// parseArgs receives full argv; it slices off the first two (node, script).
const argv = (...rest: string[]) => ["bun", "imp-x", ...rest];

test("bare prompt is preserved (regression: --effort once dropped arg 0)", () => {
  const r = parseArgs(argv("summarize the history"));
  expect(r.prompt).toBe("summarize the history");
  expect(r.interactive).toBe(true);
  expect(r.effort).toBeUndefined();
  expect(r.noArgs).toBe(false);
});

test("multi-word prompt with no flags", () => {
  const r = parseArgs(argv("list", "my", "open", "PRs"));
  expect(r.prompt).toBe("list my open PRs");
  expect(r.interactive).toBe(true);
});

test("--run forces non-interactive streaming and keeps prompt", () => {
  const r = parseArgs(argv("--run", "list", "my", "open", "PRs"));
  expect(r.run).toBe(true);
  expect(r.interactive).toBe(false);
  expect(r.prompt).toBe("list my open PRs");
});

test("-q sets quiet and keeps prompt", () => {
  const r = parseArgs(argv("-q", "say hi"));
  expect(r.quiet).toBe(true);
  expect(r.interactive).toBe(false);
  expect(r.prompt).toBe("say hi");
});

test("--effort <level> is parsed and removed from prompt", () => {
  const r = parseArgs(argv("--effort", "low", "say hi"));
  expect(r.effort).toBe("low");
  expect(r.prompt).toBe("say hi");
});

test("--effort can trail the prompt", () => {
  const r = parseArgs(argv("list my PRs", "--effort", "minimal"));
  expect(r.effort).toBe("minimal");
  expect(r.prompt).toBe("list my PRs");
});

test("-i sets interactive", () => {
  expect(parseArgs(argv("-i")).interactive).toBe(true);
});

test("--no-warm sets noWarm and keeps prompt", () => {
  const r = parseArgs(argv("--no-warm", "say hi"));
  expect(r.noWarm).toBe(true);
  expect(r.interactive).toBe(false);
  expect(r.prompt).toBe("say hi");
});

test("--serve flag", () => {
  expect(parseArgs(argv("--serve")).serve).toBe(true);
  expect(parseArgs(argv("--daemon")).serve).toBe(true); // back-compat alias
});

test("no args sets noArgs", () => {
  const r = parseArgs(argv());
  expect(r.noArgs).toBe(true);
  expect(r.interactive).toBe(true);
  expect(r.prompt).toBe("");
});

test("--help flag", () => {
  expect(parseArgs(argv("--help")).help).toBe(true);
});

test("combined flags + prompt", () => {
  const r = parseArgs(argv("-q", "--effort", "high", "open", "the", "PR"));
  expect(r.quiet).toBe(true);
  expect(r.effort).toBe("high");
  expect(r.prompt).toBe("open the PR");
});

import { stdinPromptSuffix } from "../lib/isolated.ts";

test("stdinPromptSuffix points the imp at the temp file", () => {
  const s = stdinPromptSuffix("/tmp/codex-imp-stdin-imp-jq-123");
  expect(s).toContain("/tmp/codex-imp-stdin-imp-jq-123");
  expect(s).toContain("piped");
});
