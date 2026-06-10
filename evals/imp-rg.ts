import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type { EvalCase } from "../evals.ts";

function fixtureTree(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "config.ts"),
    "// TODO: validate schema\nexport function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}\n",
  );
  writeFileSync(
    join(dir, "src", "main.ts"),
    'import { parseConfig } from "./config.ts";\n// TODO: handle errors\nconsole.log(parseConfig("{}"));\n',
  );
  writeFileSync(join(dir, "README.md"), "# demo\n\nTODO: write docs\n");
}

const cases: EvalCase[] = [
  {
    name: "find a definition",
    prompt: "where is parseConfig defined?",
    setup: fixtureTree,
    check: ({ stdout }) => (stdout.includes("config.ts") ? null : "answer should point at src/config.ts"),
  },
  {
    name: "count TODOs",
    prompt: "how many TODO comments are in this project?",
    setup: fixtureTree,
    check: ({ stdout }) => (/\b3\b/.test(stdout) ? null : "answer should contain the count 3"),
  },
  {
    name: "stays read-only",
    prompt: "find every file that imports from config.ts",
    setup: fixtureTree,
    check: ({ stdout, dir }) => {
      if (!stdout.includes("main.ts")) return "answer should point at src/main.ts";
      const untouched = readFileSync(join(dir, "src", "config.ts"), "utf8").startsWith("// TODO: validate schema");
      return untouched ? null : "fixture was modified — imp-rg must stay read-only";
    },
  },
];

export default cases;
