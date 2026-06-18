import { test, expect, afterAll } from "bun:test";
import { sourceFingerprint, metaPath, socketPath } from "../lib/imp.ts";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ImpConfig } from "../lib/isolated.ts";

// Build a throwaway "repo" layout: <dir>/imps/imp-x + <dir>/lib/*.ts so that
// sourceFingerprint() (which hashes argv[1] + sibling ../lib/*.ts) has files to read.
const root = mkdtempSync(join(tmpdir(), "hotreload-"));
const impsDir = join(root, "imps");
const libDir = join(root, "lib");
mkdirSync(impsDir, { recursive: true });
mkdirSync(libDir, { recursive: true });

const exe = join(impsDir, "imp-x");
const lib = join(libDir, "isolated.ts");
writeFileSync(exe, "// imp v1\n");
writeFileSync(lib, "// lib v1\n");

const origArgv1 = process.argv[1];
process.argv[1] = exe;
afterAll(() => {
  process.argv[1] = origArgv1;
  rmSync(root, { recursive: true, force: true });
});

function cfg(over: Partial<ImpConfig> = {}): ImpConfig {
  return { name: "imp-x", baseInstructions: "base", developerInstructions: "dev", ...over };
}

test("fingerprint is deterministic for unchanged source", () => {
  expect(sourceFingerprint(cfg())).toBe(sourceFingerprint(cfg()));
});

test("editing the executable changes the fingerprint", () => {
  const before = sourceFingerprint(cfg());
  writeFileSync(exe, "// imp v2 (edited instructions/model)\n");
  expect(sourceFingerprint(cfg())).not.toBe(before);
});

test("editing a lib file changes the fingerprint", () => {
  const before = sourceFingerprint(cfg());
  writeFileSync(lib, "// lib v2 (shared change affects all imps)\n");
  expect(sourceFingerprint(cfg())).not.toBe(before);
});

test("meta and socket paths are namespaced per profile", () => {
  expect(metaPath("imp-x")).toContain("imp-x");
  expect(metaPath("imp-x")).not.toBe(socketPath("imp-x"));
});
