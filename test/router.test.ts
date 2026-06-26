import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ROUTER = join(import.meta.dir, "..", "imp.ts");

function which(...args: string[]): { out: string; code: number | null } {
  const res = spawnSync("bun", [ROUTER, "--which", ...args], { encoding: "utf8" });
  return { out: (res.stdout + res.stderr).trim(), code: res.status };
}

test("routes by keyword to the right imp", () => {
  expect(which("what changed in git since yesterday?").out).toBe("imp-git");
  expect(which("list my open PRs").out).toBe("imp-gh");
  expect(which("trim the first 10 seconds off intro.mp4").out).toBe("imp-ffmpeg");
  expect(which("run the dev server in a right split").out).toBe("imp-cmux");
  expect(which("any unread email from alice?").out).toBe("imp-gmail");
  expect(which("How many DESIGN.md files can you find on github that have been created in the past 2 months?").out).toBe("imp-github-examples");
  expect(which("check the codex app-server runtime").out).toBe("imp-codex");
});

test("explicit tool prefix routes deterministically", () => {
  expect(which("git", "what changed?").out).toBe("imp-git");
  expect(which("jq", "count the users").out).toBe("imp-jq");
  expect(which("imp-docker", "what is running?").out).toBe("imp-docker");
});

test("no match lists candidates and exits 2", () => {
  const r = which("knit me a sweater");
  expect(r.code).toBe(2);
  expect(r.out).toContain("no imp matched");
  expect(r.out).toContain("imp-git");
});

test("compound prompt splits into sequential imps", () => {
  const r = which("find all the TODOs in src; then commit the changes");
  expect(r.code).toBe(0);
  const lines = r.out.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("imp-rg");
  expect(lines[0]).toContain("find all the TODOs in src");
  expect(lines[1]).toContain("imp-git");
  expect(lines[1]).toContain("commit the changes");
});

test("'then' splits, but an unclear segment falls back to whole-prompt routing", () => {
  expect(which("open a new pane beneath this one then cd to ~/.agents").out).toBe("imp-cmux");
});

test("a bare 'and' never splits a single task", () => {
  expect(which("open a new pane beneath this one and cd to ~/.agents").out).toBe("imp-cmux");
});

test("segments routing to the same imp stay one dispatch", () => {
  expect(which("count the json objects; then list the json keys").out).toBe("imp-jq");
});

test("imps CLI forwards free-text prompts to the router", () => {
  const IMPS = join(import.meta.dir, "..", "imps.ts");
  const r = spawnSync("bun", [IMPS, "--which", "what changed in git since yesterday?"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("imp-git");
  expect(r.stderr).toContain("routing via");
  // A near-miss subcommand must NOT forward (no money spent on a typo).
  const typo = spawnSync("bun", [IMPS, "lis"], { encoding: "utf8" });
  expect(typo.status).toBe(1);
  expect(typo.stdout).toContain("Usage:");
});

test("-l lists routes and --help prints usage", () => {
  const list = spawnSync("bun", [ROUTER, "-l"], { encoding: "utf8" });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("imp-cmux");
  const help = spawnSync("bun", [ROUTER, "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage:");
});
