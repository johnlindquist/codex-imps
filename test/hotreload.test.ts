import { test, expect, afterAll } from "bun:test";
import { sourceFingerprint, metaPath, socketPath } from "../lib/daemon.ts";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProfileConfig } from "../lib/isolated.ts";

// Build a throwaway "repo" layout: <dir>/daemons/pro-x + <dir>/lib/*.ts so that
// sourceFingerprint() (which hashes argv[1] + sibling ../lib/*.ts) has files to read.
const root = mkdtempSync(join(tmpdir(), "hotreload-"));
const daemonsDir = join(root, "daemons");
const libDir = join(root, "lib");
mkdirSync(daemonsDir, { recursive: true });
mkdirSync(libDir, { recursive: true });

const exe = join(daemonsDir, "pro-x");
const lib = join(libDir, "isolated.ts");
writeFileSync(exe, "// daemon v1\n");
writeFileSync(lib, "// lib v1\n");

const origArgv1 = process.argv[1];
process.argv[1] = exe;
afterAll(() => {
  process.argv[1] = origArgv1;
  rmSync(root, { recursive: true, force: true });
});

function cfg(over: Partial<ProfileConfig> = {}): ProfileConfig {
  return { name: "pro-x", baseInstructions: "base", developerInstructions: "dev", ...over };
}

test("fingerprint is deterministic for unchanged source", () => {
  expect(sourceFingerprint(cfg())).toBe(sourceFingerprint(cfg()));
});

test("editing the executable changes the fingerprint", () => {
  const before = sourceFingerprint(cfg());
  writeFileSync(exe, "// daemon v2 (edited instructions/model)\n");
  expect(sourceFingerprint(cfg())).not.toBe(before);
});

test("editing a lib file changes the fingerprint", () => {
  const before = sourceFingerprint(cfg());
  writeFileSync(lib, "// lib v2 (shared change affects all daemons)\n");
  expect(sourceFingerprint(cfg())).not.toBe(before);
});

test("editing an active self-improvement lessons overlay changes the fingerprint", () => {
  // The shared self-improvement runtime appends to `<exe>.lessons.md`; the next prompt must hot-reload.
  const lessons = `${exe}.lessons.md`;
  const active = cfg({ selfImprove: { enabled: true, lessonsPath: lessons } });
  const before = sourceFingerprint(active);
  writeFileSync(lessons, "- learned: read stderr before retrying\n");
  expect(sourceFingerprint(active)).not.toBe(before);
});

test("editing a disabled self-improvement lessons sidecar does not change the fingerprint", () => {
  const lessons = `${exe}.lessons.md`;
  const disabled = cfg();
  const before = sourceFingerprint(disabled);
  writeFileSync(lessons, "- ignored while disabled\n");
  expect(sourceFingerprint(disabled)).toBe(before);
});

test("editing the debug receipt log does not change the fingerprint", () => {
  const lessons = `${exe}.lessons.md`;
  const active = cfg({ selfImprove: { enabled: true, lessonsPath: lessons } });
  writeFileSync(lessons, "- stable lesson\n");
  const before = sourceFingerprint(active);
  writeFileSync(`${lessons}.debug.jsonl`, '{"event":"debug"}\n');
  expect(sourceFingerprint(active)).toBe(before);
});

test("meta and socket paths are namespaced per profile", () => {
  expect(metaPath("pro-x")).toContain("pro-x");
  expect(metaPath("pro-x")).not.toBe(socketPath("pro-x"));
});
