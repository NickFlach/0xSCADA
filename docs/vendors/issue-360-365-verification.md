# Vendor Byte-Level Fix Cluster (#360–365): Verification Report

> Gate record for issue #450, verified 2026-07-21 against `main` @ `2e82fbc40`.
> Issues #360–365 were bulk-closed 2026-03-04 without verification comments;
> this report establishes what actually happened to each fix.

## Verdict summary

**One commit fixed everything; one merge silently un-fixed a third of it.**

- Fix commit: `c575cc655` "Fix critical/high QE findings" (2026-03-04, merged via PR #436).
- Regression: a parallel branch commit `f8e7bcb19` (2026-03-04 07:50, **pre-fix**)
  was merged on 2026-03-15 in `4efe59bc5` "Merge origin/main - resolve vendor
  adapter conflicts", whose conflict resolution took the pre-fix side of
  `siemens-adapter.ts` wholesale. `git diff f8e7bcb19 HEAD -- server/services/vendors/siemens-adapter.ts`
  is empty — HEAD equals the pre-fix version.
- **No regression test exists for any of the six issues**, which is exactly why
  the revert went unnoticed for four months.

## Status table

| Issue | Bug | Verdict | Fix commit | Surface at HEAD | Test |
|---|---|---|---|---|---|
| #360 | Emerson Modbus `WriteMultipleRegisters` hardcoded unitId | **fixed-no-test** | `c575cc655` | `server/services/vendors/modbus-utils.ts:86-95` (unitId written at MBAP offset 6, `:52`) | none |
| #361 | HART short-frame off-by-one allocation | **fixed-no-test** | `c575cc655` | `server/services/vendors/emerson-adapter.ts:202` (byteCount byte in allocation) | none |
| #362 | Siemens S7 `buildS7SzlRead` missing SZL ID/Index data section | **NOT FIXED — reverted** by `4efe59bc5` | `c575cc655` | `server/services/vendors/siemens-adapter.ts:365-393` — 24-byte buffer, data length 4, params unused | none |
| #363 | Protocol counter overflows | **NOT FIXED — partial + reverted** | `c575cc655` (partial) | pduRef unbounded `++` at `siemens-adapter.ts:704,739,770,783,791,799,812` → `RangeError` at 65536; Schneider `sendSeq` masking retained (`schneider-adapter.ts:701,859,922,1003,1014`); K=12 unconfirmed-frame check never implemented; Modbus transaction IDs wrap but are module-level, shared across all adapters (`modbus-utils.ts:34-40`) | none |
| #364 | PID relay feedback stored PV values as timestamps | **fixed-no-test** | `c575cc655` | `server/services/optimization/pid-autotuner.ts:265-272, 89-90` (separate `peaks`/`peakValues` series) | none |
| #365 | PID anti-windup floating-point comparison | **fixed-no-test** | `c575cc655` | `server/services/optimization/pid-controller.ts:137-141` (epsilon `1e-10` on unclamped delta) | none |

## Notes

- The restore/cli-full merge `53a65bd35` made zero changes to
  `server/services/vendors/` or `server/services/optimization/` relative to its
  main parent — its recent-looking touches are not the fixes.
- `#365` doesn't appear in `c575cc655`'s commit message but the fix is present
  in its diff (why grep-by-issue-number finds nothing).
- No duplicate bug sites: `server/adapters/siemens-s7.ts` and `server/gateway/`
  contain no SZL/pduRef/unitId surfaces.
- Full test-file enumeration (cli, server, fuzz, e2e) contains zero references
  to `buildS7SzlRead`, `encodeHartShortFrame`, `WriteMultipleRegisters`,
  `pduRef`, `sendSeq`, `relayFeedback`, or anti-windup symbols.

## Follow-ups

- **#484** (filed from this gate): restore the #362 SZL fix and #363 pduRef
  masking, implement the never-written K=12 check, make Modbus transaction IDs
  per-connection, and add byte-level regression tests for all six items so a
  merge can never silently undo them again.
