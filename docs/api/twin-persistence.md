# Digital-twin persistence

Issue #550 — ADR-0013 [13.3]

The digital-twin runtime used to keep registered `ProcessModel` definitions and
simulation state in process memory only, so a restart lost the model registry
and every checkpoint. Both are now durable.

## What is stored

| Table | Contents |
| --- | --- |
| `twin_models` | One row per registered model: the authored `ProcessModel` definition, keyed by the model id, plus the schema version it was written under. |
| `twin_checkpoints` | The **last committed** simulation state per model: tick, simulated clock, per-component parameter values, and the last live-sync timestamp. |

Physical DDL: `migrations/0014_twin_persistence.sql` (PostgreSQL) and the
`SQLITE_DDL` in `server/services/twin/persistence.ts` (development fallback).
The two Drizzle definitions in `shared/schema.ts` and `shared/schema-sqlite.ts`
are held in sync by `shared/__tests__/schema-parity.test.ts`.

Neither table has a `status` or `running` column, and that is deliberate — see
below.

## A restart never resumes a simulation

A restored simulation always comes back **idle**, whatever it was doing when
its checkpoint was committed. The stored schema cannot express "resume on
boot": run status is not persisted at all. Restoring does not start a timer,
does not step, and does not assimilate live tag data. An authorized caller must
explicitly `POST /api/twin/models/:modelId/start` or `.../step` before the
model does anything.

The twin remains advisory and read-only toward the plant (ADR-0009); nothing in
this feature introduces a plant-output or control-write path.

## Checkpoints are explicit

```
POST /api/twin/models/:modelId/checkpoint      scope: twin.operate
```

Commits the model's simulation state **at the instant of the call** as its
durable checkpoint and returns it. The runtime keeps advancing afterwards;
those later ticks are not durable until the next commit. A restart restores the
last committed checkpoint, not the last tick that happened to run.

An initial checkpoint is written when the model is registered, in the same
transaction as the definition, so a registered model always has one.

No other route writes a checkpoint. `start`, `stop`, `step`, `reset` and `sync`
change only in-memory state, so **a restart after a `reset` restores the
pre-reset checkpoint**, not the reset state — the restored simulation can be
older than what the twin last showed. Commit a checkpoint after any state
change you need to survive a restart.

## Atomicity

`POST /api/twin/models` and `DELETE /api/twin/models/:modelId` mutate storage
and the in-memory registry inside one database transaction:

* the runtime rejects the model → nothing is written and nothing changes;
* the durable write or the commit fails → the transaction rolls back **and**
  the in-memory registry is restored from the snapshot taken before the
  mutation, including the replaced model's simulation state and live actuals.

A storage failure on these routes answers `503`, not `400`: the request was
well-formed, and the twin refuses to hold state it cannot durably store.

The startup restore holds the store exclusively while it reads the stored rows
**and** while it applies them to the runtime, so a registration or delete
arriving mid-restore is ordered against it rather than silently overwritten in
memory by rows the restore had already read. Such a request waits for the
restore to finish and then applies on top of it.

## Corrupt or unreadable rows fail closed, one model at a time

At startup each stored model is decoded, version-checked and re-validated by
the runtime, and its checkpoint is validated against the model's components. A
row that fails any of those checks is **refused for that model only** — every
other valid model still loads. Refused rows are reported, never repaired:

* a definition that is not readable JSON, or not a valid process model;
* a `schema_version` this build does not know;
* a checkpoint whose component states do not match the model, or that contains
  a non-finite value;
* a model row with no checkpoint row, which can only be a torn write. It is
  refused rather than re-seeded from authored initial conditions, because
  substituting authored state for real state would be indistinguishable from
  inventing it.

Refusals are visible on:

```
GET /api/twin/status                            scope: twin.read
```

under `persistence.lastRestore.failed`, each entry naming the model, whether
the definition or the checkpoint was rejected, and why. `persistence.error` is
set instead when storage could not be read at all — in that case the runtime
starts empty and later writes still fail loudly rather than silently running
without durability.

### Clearing a refused model

The stored rows are left untouched, so an operator can either

* re-register the model with `POST /api/twin/models`, which replaces the
  definition and checkpoint atomically, or
* remove it with `DELETE /api/twin/models/:modelId`, which reaches models that
  the last restore refused as well as loaded ones.

## Limits

A stored model definition or checkpoint payload is capped at 16 MiB
(`MAX_PERSISTED_PAYLOAD_BYTES`). The cap sits above what the runtime's own
structural limits can produce. An oversized payload is refused outright; a
checkpoint is never truncated.

## Configuration

The store follows the same backend selection as `server/storage.ts`: PostgreSQL
when `DATABASE_URL` is set, `FORCE_POSTGRES` is not `false`, and `NODE_ENV` is
not `development`; otherwise a SQLite file resolved from
`TWIN_STATE_SQLITE_PATH`, then `SQLITE_DATABASE_PATH`, then
`./dev-database.sqlite`. The connection opens lazily on first use.
