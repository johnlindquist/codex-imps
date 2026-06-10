import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { EvalCase } from "../evals.ts";

const USERS = JSON.stringify(
  [
    { id: 1, name: "alice", plan: "pro" },
    { id: 2, name: "bob", plan: "free" },
    { id: 3, name: "carol", plan: "free" },
    { id: 4, name: "dana", plan: "pro" },
    { id: 5, name: "erin", plan: "free" },
  ],
  null,
  2,
);

const cases: EvalCase[] = [
  {
    name: "count array elements",
    prompt: "how many users are in users.json?",
    setup: (dir) => writeFileSync(join(dir, "users.json"), USERS),
    check: ({ stdout }) => (/\b5\b/.test(stdout) ? null : "answer should contain the count 5"),
  },
  {
    name: "filter by field",
    prompt: "list the names of users on the pro plan from users.json",
    setup: (dir) => writeFileSync(join(dir, "users.json"), USERS),
    check: ({ stdout }) => {
      const s = stdout.toLowerCase();
      if (!s.includes("alice") || !s.includes("dana")) return "should name alice and dana";
      if (s.includes("bob") || s.includes("carol") || s.includes("erin")) return "should not include free-plan users";
      return null;
    },
  },
  {
    name: "csv export to a new file, input untouched",
    prompt: "export the id and name of each user in users.json to users.csv",
    setup: (dir) => writeFileSync(join(dir, "users.json"), USERS),
    check: ({ dir }) => {
      const csv = join(dir, "users.csv");
      if (!existsSync(csv)) return "users.csv was not created";
      const body = readFileSync(csv, "utf8").toLowerCase();
      if (!body.includes("alice") || !body.includes("erin")) return "users.csv missing rows";
      if (readFileSync(join(dir, "users.json"), "utf8") !== USERS) return "users.json was modified — must never overwrite input";
      return null;
    },
  },
];

export default cases;
