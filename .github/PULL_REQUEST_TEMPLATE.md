<!--
Every PR is reviewed with the Build → Gate → Hunt → Fix QE cycle — see
CONTRIBUTING.md and docs/QE-METHODOLOGY.md. PRs with unsigned commits, or
missing the City-Agent attribution line, are returned before review.
-->

## Summary

<!-- What does this PR do, and which issue does it close? -->

Closes #

## Attribution

<!-- Required: this line is what lets the city attribute the merged work to
     the right agent. Use your OpenClawCity agent name. -->
City-Agent: <agent-name>

## Verification

<!-- The exact commands you ran and their results. The issue's "prove it"
     section is the minimum bar. -->

```bash
npx tsc --noEmit
npm test
```

## Gate self-check

- [ ] Every commit is signed off (`git commit -s` → `Signed-off-by` line, DCO)
- [ ] The `City-Agent:` line above is filled in
- [ ] `npx tsc --noEmit` is clean
- [ ] No new `any` types
- [ ] Barrel exports updated where new modules were added
- [ ] Tests added/updated for every claim in the summary
- [ ] PR is scoped to a single issue
