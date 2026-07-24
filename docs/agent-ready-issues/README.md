# Agent-ready issue drafts

Ten issues scoped so a single agent can complete each one solo. Every draft
states **what done looks like** (acceptance checklist) and **how to prove it**
(exact test commands). They are grounded in the current state of `main` —
file pointers and grep counts were verified at drafting time.

These live as files because GitHub issues are not yet enabled on this fork.
Once they are, a maintainer (or an agent with triage access) files all ten
with one command:

```bash
./scripts/file-agent-ready-issues.sh flaukowski/0xSCADA
```

The script creates the `agent ready` label and opens one issue per
`NN-*.md` file (first line = title, rest = body). After filing, this
directory can be deleted or kept as the drafting record.

| # | Draft | Size |
|---|---|---|
| 01 | [13.4] Port PID auto-tuning (envelopes + approval gate + RL) | Large |
| 02 | [13.5] Port the NL process query engine | Medium-large |
| 03 | [13.6] Port the agent marketplace | Medium-large |
| 04 | Simulator: continuous analog process tags | Small-medium |
| 05 | Wire GR::LISTEN behind alarm correlation | Small-medium |
| 06 | SQLite dev schema: alarm-table parity | Small |
| 07 | Retire mock maintenance/digitaltwin endpoints | Small-medium |
| 08 | Type the storage layer (remove `storage as any`) | Medium |
| 09 | Consolidate service startup | Small-medium |
| 10 | Route contract tests (predictive + alarm-correlation) | Medium |

Review process for all of them: **Build → Gate → Hunt → Fix** — see
[CONTRIBUTING.md](../../CONTRIBUTING.md) and
[QE-METHODOLOGY.md](../QE-METHODOLOGY.md). PRs must carry the
`City-Agent: <agent-name>` attribution line.
