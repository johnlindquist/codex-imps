# VISION

> A swarm of tiny familiars, each bound to a single tool, so good at their one
> job that you forget the tool ever had a syntax.

## The perfect future

You never read a man page again.

When you need something from `git`, `jq`, `ffmpeg`, or any of the hundred
sharp-edged tools on your machine, you say what you want in plain words. An
imp — small, warm, already awake — does it in the time it would have taken you
to type the flags, tells you exactly what it ran, and vanishes. You don't pick
the imp; `imp "..."` knows. You don't manage the fleet; it manages itself.

Every imp is an expert in precisely one thing. Not a general agent that has
*heard* of jq — a creature that lives inside jq, dreams in filters, samples
your data's shape before writing a single expression, and would sooner refuse
than overwrite your source file. The expertise doesn't come from a big model;
it comes from a prompt so well-built that a small, cheap, fast model can't
help but get it right.

And the imps get better while you sleep. Every command that fails becomes a
lesson. Lessons that keep earning their place graduate into the imp's
permanent error-recovery reflexes; lessons that stop mattering age out. An
imp you've used for a month is measurably better than the day you summoned
it — and the evals prove it, because trust is measured, never assumed.

## The creed

1. **One imp, one tool.** An imp that knows two tools knows neither. Scope is
   the whole trick: a narrow prompt beats a large model.
2. **Dumb model, brilliant prompt.** Intelligence lives in worked examples and
   error→fix maps the model can imitate, not in reasoning we hope it does.
   When models get smarter, imps get *cheaper* — never the reverse.
3. **Mischief, never malice.** Imps are playful but incapable of harm by
   default: read before write, preview before commit, never overwrite an
   input, least privilege always. The guarded path is the easy path.
4. **Every failure is tuition.** A failed command is not an error to hide; it
   is the raw material of the next, better imp. No mistake should survive
   being made twice.
5. **Trust is measured.** If a guardrail isn't covered by an eval, it's a
   wish, not a guarantee. Behavior changes only ship with proof.
6. **The fleet is invisible.** Warm when you need them, gone when you don't.
   No servers to babysit, no state to clean up, nothing to remember.
7. **Unix citizens.** Pipes in, plain text out, exit codes that mean things.
   An imp composes with everything that came before it.
8. **Small enough to read whole.** Any imp, top to bottom, in one sitting.
   The day that stops being true, we've built the wrong thing.

## We'll know we've arrived when…

- A brand-new CLI tool gets a *competent* imp in five minutes and a *great*
  one within a week of real use — purely from accumulated lessons.
- The answer routinely arrives faster than you could have typed the command
  yourself.
- A month of heavy use costs less than lunch.
- You hand an imp your real repo, your real database, your real photo
  library — without a flicker of hesitation — because the evals run on every
  change and the sandbox makes the dangerous thing impossible, not just
  discouraged.
- `imp "..."` routes correctly so often you've forgotten the imps' names.
- A mature imp's lessons file reads like the tool's missing FAQ — and its
  best lessons have already been promoted into the prompt.
- Sharing an imp is as easy as sharing a dotfile, and summoning someone
  else's imp is as safe as reading one.

## What imps will never be

- **Not a general agent.** No imp will ever "figure out the right tool."
  Breadth is the router's job; an imp's job is depth.
- **Not a framework.** No plugin system, no YAML, no orchestration graphs,
  no config sprawl. An imp is one executable file you can read.
- **Not a chat.** One prompt, one answer, exit. Conversation is someone
  else's product.
- **Not impressive at your expense.** An imp will never trade safety or
  predictability for a flashier demo. Boring and correct beats clever and
  occasionally catastrophic.

## The road from here

The pieces exist: warm processes, classified self-improvement, lesson aging
and promotion, per-imp sandboxes, a router, a fleet CLI, and evals that
already catch real bugs. The distance between here and the vision is mostly
*accumulation* — more imps, deeper lessons, broader eval coverage — plus a
few missing organs: lessons shared across imps where failures rhyme, a
promotion pipeline that closes the loop from lesson to prompt automatically,
and an imp registry so the swarm can spread beyond one machine.

Every change to this repo should move toward the world above. If it doesn't,
it doesn't belong here.
