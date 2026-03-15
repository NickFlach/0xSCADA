# QE Methodology: Devil's Advocate with Agentic-QE Patterns

> Formalized quality engineering workflow for 0xSCADA, integrating lessons from the agentic-qe fleet patterns with our proven devil's advocate approach.

## Overview

Every code wave follows a **Build → Gate → Hunt → Fix** cycle. Quality is enforced at every transition.

```
┌─────────┐    ┌──────────────┐    ┌───────────────┐    ┌─────────┐
│  BUILD  │───►│ QUALITY GATE │───►│ DEVIL'S ADVOCATE │───►│  FIX   │
│ (Wave)  │    │  (Go/No-Go)  │    │  (Adversarial)  │    │ (Triage)│
└─────────┘    └──────────────┘    └───────────────┘    └─────────┘
     │                                                        │
     └────────────────── next wave ◄──────────────────────────┘
```

## Phase 1: Build

Sub-agents implement features from ADR-defined issues. Rules:

- **One ADR wave at a time** — prevents rate limits and git conflicts
- **Sequential over parallel** when quality matters more than speed
- Verify TypeScript compilation before proceeding (`npx tsc --noEmit`)
- Each sub-agent gets: ADR text, issue description, existing code context, shared types

### Testability Check (Pre-Build)

Before writing code, score each issue for testability risk:

| Factor | Score | Criteria |
|--------|-------|----------|
| Pure functions | +2 | No side effects, deterministic |
| Injected dependencies | +1 | Constructor/parameter injection |
| Global state | -2 | Singletons, module-level mutation |
| Async chains | -1 | Nested promises, callback depth > 2 |
| External I/O | -1 | File system, network, database |

**Threshold**: Score ≥ 0 to proceed. Score < 0 requires design review.

## Phase 2: Quality Gate

After build completes, run a formal go/no-go check before adversarial review.

### Gate Thresholds

| Metric | Foundation Wave | Feature Wave | Integration Wave |
|--------|----------------|--------------|------------------|
| TypeScript errors | 0 | 0 | 0 |
| Exported without types | 0 | 0 | 0 |
| Functions > 80 lines | ≤ 2 | ≤ 3 | ≤ 5 |
| `any` type usage | 0 new | 0 new | 0 new |
| Barrel exports updated | Required | Required | Required |
| ADR compliance | Full | Full | Full |

### Gate Decision

- **PASS** → Proceed to devil's advocate
- **CONDITIONAL** → Fix gate failures first, re-check
- **FAIL** → Rebuild wave (should be rare with good ADRs)

### Automated Gate Checks

```bash
# TypeScript compilation
npx tsc --noEmit

# Count new `any` usage (compare to main)
git diff main -- '*.ts' | grep -c ': any'

# Long function detection
grep -rn 'function\|=>' server/services/ | # pipe to line counter per function
```

## Phase 3: Devil's Advocate

An adversarial sub-agent reviews ALL new/modified files with the explicit goal of finding bugs, design flaws, and spec violations.

### Adversarial Prompt Template

```
You are a devil's advocate QE reviewer. Your job is to FIND PROBLEMS.

Context: [ADR name], Wave [N], [file list]

Review checklist:
1. CORRECTNESS: Does the code do what the ADR specifies?
2. TYPES: Any `any` types, missing generics, unsafe casts?
3. MEMORY: Unbounded arrays, maps without eviction, event listener leaks?
4. CONCURRENCY: Race conditions, shared mutable state?
5. ERROR HANDLING: Unhandled promise rejections, missing try/catch?
6. EDGE CASES: Empty arrays, NaN, undefined, overflow?
7. SCALING: O(n²) or worse in hot paths? Unbounded growth?
8. INTEGRATION: Does it wire correctly into existing systems?
9. SECURITY: Injection points, unvalidated input, information leaks?
10. NAMING: Misleading names, inconsistent conventions?

Regression risk focus:
- Files with most changes get most scrutiny
- Cross-module interfaces are highest risk
- New event emitters/listeners need lifecycle verification

For each issue found, file with:
- Title: [Severity] Brief description
- Body: File, line, what's wrong, suggested fix
- Labels: bug + severity label
```

### Severity Classification

| Severity | Criteria | Response |
|----------|----------|----------|
| Critical | Data corruption, crashes, security holes | Fix before any other work |
| High | Incorrect behavior, spec violations | Fix in current wave |
| Medium | Performance issues, poor patterns | Fix or create follow-up issue |
| Low | Style, naming, minor improvements | Batch into refactor PR |

### Regression Risk Scoring

Focus devil's advocate time proportionally:

```
Risk = (lines_changed × 0.3) + (cross_module_refs × 0.4) + (complexity × 0.3)
```

- **High risk** (> 7): Deep review, trace all call paths
- **Medium risk** (4-7): Standard review
- **Low risk** (< 4): Skim for obvious issues

## Phase 4: Fix

Triage issues by severity, fix in priority order:

1. **Critical + High**: Immediate fix PR
2. **Medium**: Same PR if small, separate if complex
3. **Low + Refactor**: Batch into cleanup PR

After fixes, re-run quality gate. If clean, proceed to next wave.

## Fleet Coordination

When running multiple sub-agents (3+):

- **Hierarchical topology**: One coordinator dispatches, workers report back
- **Branch isolation**: Each agent gets its own branch, merge sequentially
- **Git conflict prevention**: Agents work on different directories/files
- **Rate limit awareness**: Stagger API calls, use sequential when hitting limits

## Learning Integration

After each QE cycle, capture patterns:

### What to Store
- Recurring bug patterns (e.g., "missing Map eviction in long-running services")
- False positives (issues that weren't actually bugs)
- ADR clarity gaps (specs that led to misimplementation)

### Where to Store
- `docs/QE-FINDINGS.md` — cumulative findings log
- Issue labels: `qe-pattern` for recurring patterns
- Memory files for agent continuity

### Feedback Loop

```
QE findings → ADR amendments → Better specs → Cleaner first-pass code
```

Our data supports this: Wave 1 QE found 9 issues, all already addressed in code. Thorough ADRs produce clean code. The devil's advocate still validates, but the real quality comes from **specification quality**.

## Code Complexity Thresholds

Flag for mandatory review:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Cyclomatic complexity | > 15 | Refactor or justify |
| Function length | > 80 lines | Split |
| Parameter count | > 5 | Use options object |
| Nesting depth | > 4 | Extract functions |
| File length | > 500 lines | Split into modules |

## Proven Results

From the ADR-0022 constellation build (2026-03-04):
- **17 issues** found by devil's advocate across 5 waves
- **6 critical** (including PID autotuner storing PV values instead of timestamps)
- **All fixed** in 3 PRs (#377-379)
- **9,000+ lines** of industrial SCADA code reviewed in one session
- **Zero regressions** after fix wave

The methodology works. The key insight: **quality comes from the ADR, not the review**. Devil's advocate catches what slips through, but detailed specifications prevent most defects at the source.

---

*References: agentic-qe fleet patterns (FleetCommanderAgent, QualityGateAgent, RegressionRiskAnalyzerAgent, CodeComplexityAnalyzerAgent)*
