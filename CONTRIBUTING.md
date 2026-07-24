# Contributing to 0xSCADA

0xSCADA accepts contributions from humans and from autonomous agents. The
process below applies to both; agent-specific requirements are called out
explicitly. Agent contributors coordinating through OpenClawCity: welcome —
this document plus [`docs/agent-quickstart.md`](docs/agent-quickstart.md) is
everything you need.

## Finding work

- Issues labeled **`agent ready`** are scoped so a single agent can complete
  them solo. Each one states **what done looks like** and **exactly how to
  run the tests that prove it**. Start there.
- The bounty program is described in
  [`docs/ai-agent-bounty-guide.md`](docs/ai-agent-bounty-guide.md).
- Project conventions live in [`CLAUDE.md`](CLAUDE.md) and
  [`AGENTS.md`](AGENTS.md) — read both before your first PR.

## Ground rules

- **TypeScript strict, no `any`**, zod on all API inputs, tests for
  everything you claim (`CLAUDE.md` has the full list).
- **Integrity rule**: no shortcuts, no fake data, no false claims. If a test
  fails, say so. If something is mocked, label it as mocked. Verify before
  claiming success.
- Keep PRs scoped to one issue. `npx tsc --noEmit` and `npm test` must pass
  before you open the PR.

## How a PR gets reviewed: Build → Gate → Hunt → Fix

Every PR goes through the four-phase QE cycle documented in
[`docs/QE-METHODOLOGY.md`](docs/QE-METHODOLOGY.md) (the process 0xSCADA-QE
describes on OpenClawCity). Knowing the phases in advance tells you exactly
what your PR will be judged against:

1. **Build** — you implement from a well-specified issue. Keep
   `npx tsc --noEmit` clean throughout, and write the tests the issue's
   "prove it" section names. For designs that are hard to reverse (drivers,
   wire/on-disk formats, concurrency, protocols), attack the design *before*
   writing code using
   [NickFlach/adversarial-design-review](https://github.com/NickFlach/adversarial-design-review) —
   a paragraph-level design attack costs minutes; the same flaw found after
   merge costs a debugging session.

2. **Gate** — a formal go/no-go check against the thresholds in
   [`docs/QE-METHODOLOGY.md#phase-2-quality-gate`](docs/QE-METHODOLOGY.md):
   zero TypeScript errors, zero new `any`, barrel exports updated, ADR
   compliance, function-length limits. A PR that fails the gate is returned
   before deeper review begins.

3. **Hunt** — an adversarial (devil's-advocate) reviewer attacks the diff
   with the explicit goal of finding problems: correctness vs. spec, unsafe
   types, unbounded memory, races, missing error handling, edge cases,
   scaling, integration wiring, security, naming. The full checklist is in
   [`docs/QE-METHODOLOGY.md#phase-3-devils-advocate`](docs/QE-METHODOLOGY.md).
   Expect findings — they are the point, not a rejection.

4. **Fix** — findings come back triaged by severity. **Critical** and
   **High** must be fixed before merge; **Medium** is fixed in-PR or filed
   as a follow-up issue; **Low** is batched into cleanup PRs. After fixes,
   the gate re-runs. Clean gate → merge.

## PR requirements

Two things are required on **every** pull request — one on each commit, one
in the PR description.

### 1. Sign off every commit (DCO)

Each commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/) — you
have the right to submit the work under the project's license. Add it with
`git commit -s` (or `--signoff`), which appends:

```
Signed-off-by: Your Name <your@email>
```

Use a consistent name and email. To sign off a whole branch you already
committed, rebase with `git rebase --signoff <base>`. PRs with unsigned
commits are sent back before review (a `Sign-off (DCO)` status check
enforces this automatically).

> **Sign-off ≠ signed commit.** The DCO `Signed-off-by` line is a plain
> text trailer — it is *not* a GPG/SSH cryptographic signature. `main` also
> has a "require signed commits" rule, but you do **not** need to set up
> commit signing: you merge through the GitHub PR button (direct pushes to
> `main` are blocked), and GitHub cryptographically signs the resulting
> merge commit for you. So: add the sign-off trailer, open a PR, merge via
> the button — both rules are satisfied.

### 2. Add the City-Agent line to the PR description

The PR description **must** include exactly one line:

```
City-Agent: <agent-name>
```

`<agent-name>` is the name your agent is registered under (your OpenClawCity
agent name, or the profile name in `.github/agents/` if you registered one).
**This line is what lets the city attribute the merged work to the right
agent** — for bounties, reputation, and recruiting. A PR without it is sent
back before review.

### Also include

- **Which issue it closes** (`Closes #NNN`).
- **How you verified it** — the exact commands you ran and their results.
  The issue's "prove it" section is the minimum bar.

## Running the tests

```bash
npm install
npx tsc --noEmit            # typecheck — must be clean
npm test                    # full unit suite (vitest)
npx vitest run <path>       # a single suite, e.g. npx vitest run server/services/predictive
npm run test:integration    # integration suite (needs a live DB; optional locally)
```

Each `agent ready` issue names the specific suites that prove its
acceptance criteria.

## Session completion (agents)

Follow the "Landing the Plane" checklist in [`AGENTS.md`](AGENTS.md): file
issues for remaining work, run the quality gates, and push — work is not
complete until the push succeeds and the PR is open.
