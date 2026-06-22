import { test, expect, afterAll } from "bun:test";
import { spawn } from "child_process";
import { readdirSync, rmSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
// Profile executables are extensionless `imp-*` files.
const PROFILES = readdirSync(join(ROOT, "imps")).filter((f) => /^imp-[a-z0-9-]+$/.test(f));

function run(args: string[], opts: { killAfterMs?: number } = {}): Promise<{ code: number | null; out: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("bun", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let killed = false;
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.killAfterMs) {
      timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, opts.killAfterMs);
    }
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, out, killed }); });
  });
}

test("every profile binary loads and prints usage on --help", async () => {
  for (const p of PROFILES) {
    const { code, out } = await run([`imps/${p}`, "--help"]);
    expect(code, `${p} --help exit code`).toBe(0);
    expect(out, `${p} --help output`).toContain("Usage:");
  }
}, 30000);

test("--help prints usage and exits 0 (not an error)", async () => {
  const { code, out } = await run(["imps/imp-minimal", "--help"]);
  expect(code).toBe(0);
  expect(out).toContain("Usage:");
});

test("a real prompt survives parsing at the binary level (regression guard)", async () => {
  // If arg parsing drops the prompt, the bin exits 1 immediately with this message
  // BEFORE any model call. We force --no-warm + kill quickly so we never pay a turn.
  const { out, killed, code } = await run(
    ["imps/imp-minimal", "--run", "--no-warm", "summarize the history"],
    { killAfterMs: 1500 },
  );
  expect(out).not.toContain("no prompt provided");
  // It should still be running (killed by us) — i.e. it got past parsing into real work.
  expect(killed || code === 130 || code === 0).toBe(true);
}, 10000);

afterAll(() => {
  // Clean any isolated homes the smoke run created.
  for (const dir of readdirSync("/tmp").filter((d) => d.startsWith("codex-imp-") || d.startsWith("codex-appserver-"))) {
    try { rmSync(join("/tmp", dir), { recursive: true, force: true }); } catch {}
  }
});
