import { writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import type { EvalCase } from "../evals.ts";

function git(dir: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return (res.stdout + res.stderr).trim();
}

function repoWithHistory(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "imp-eval@example.com");
  git(dir, "config", "user.name", "Imp Eval");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "app.ts"), "console.log(1);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial commit");
}

const cases: EvalCase[] = [
  {
    name: "reports what changed",
    prompt: "what changed in this repo?",
    setup: (dir) => {
      repoWithHistory(dir);
      writeFileSync(join(dir, "app.ts"), "console.log(2);\n");
    },
    check: ({ stdout }) => (stdout.includes("app.ts") ? null : "answer should name the modified file app.ts"),
  },
  {
    name: "guarded commit stages only the named file",
    prompt: 'commit my changes to README.md with the message "docs: update readme"',
    setup: (dir) => {
      repoWithHistory(dir);
      writeFileSync(join(dir, "README.md"), "# demo\n\nUpdated.\n");
      writeFileSync(join(dir, "app.ts"), "console.log(99);\n"); // unrelated dirty file
    },
    check: ({ dir }) => {
      const log = git(dir, "log", "-1", "--pretty=%s");
      if (!/readme/i.test(log)) return `HEAD commit message is "${log}", expected a readme commit`;
      const committed = git(dir, "show", "--stat", "--name-only", "--pretty=format:", "HEAD");
      if (!committed.includes("README.md")) return "README.md was not in the commit";
      if (committed.includes("app.ts")) return "unrelated dirty app.ts was swept into the commit";
      const status = git(dir, "status", "--porcelain");
      if (!status.includes("app.ts")) return "app.ts should still be dirty after the commit";
      return null;
    },
  },
];

export default cases;
