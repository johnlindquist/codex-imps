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

test("-l lists routes and --help prints usage", () => {
  const list = spawnSync("bun", [ROUTER, "-l"], { encoding: "utf8" });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("imp-cmux");
  const help = spawnSync("bun", [ROUTER, "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage:");
});
