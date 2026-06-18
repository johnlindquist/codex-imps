import { afterAll, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "imp-evolve-command-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runImp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["imp.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, IMP_HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code, signal) => resolve({ code: signal ? 130 : code ?? 0, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

test("imp evolve delegates to the fleet evolution command", async () => {
  const result = await runImp(["evolve", "imp-missing"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("imp-missing has no pending evolutions");
  expect(result.stderr).toBe("");
});
