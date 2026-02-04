# Reality Artifact Swarm Doctrine

## The Prime Directive

**Artifacts are truth.**

In the 0xSCADA ecosystem, reality is not assumed—it is captured, verified, and versioned. The artifact is the fundamental unit of truth. Everything else is interpretation.

---

## Core Tenets

### 1. Artifacts Are Truth

An artifact is an immutable record of what occurred. It cannot be argued with, only interpreted. When code and artifacts disagree, trust the artifact.

- A trace captures what the kernel observed
- A proof captures what was mathematically verified  
- A witness enables independent verification
- An embedding captures what the agent understood

Reality is the sum of all valid artifacts.

### 2. Code Is Intent; Artifacts Are Evidence

Code expresses what *should* happen. Artifacts record what *did* happen.

```
Intent:     "The valve should close when pressure exceeds 150 PSI"
Evidence:   trace/valve-001-2024-01-15T14:32:07.trace
            → Pressure: 152.3 PSI
            → Valve state: OPEN
            → Duration: 847ms
```

When investigating failures, start with artifacts. Code explains the design; artifacts explain reality.

### 3. Every Decision Must Be Replayable

No agent action exists in a vacuum. Every decision must be:

- **Traceable**: Which inputs led to this decision?
- **Verifiable**: Can an independent observer reach the same conclusion?
- **Replayable**: Given the same artifacts, will the decision repeat?

If you cannot replay a decision from its artifacts, the decision is untrustworthy.

### 4. Failure Is Not Error; Unrecorded Failure Is

Systems fail. This is expected. The cardinal sin is not failure—it is *unobserved* failure.

| Scenario | Verdict |
|----------|---------|
| Component fails, artifact captured | ✓ Acceptable |
| Component fails, artifact missing | ✗ Critical |
| Component succeeds, artifact captured | ✓ Ideal |
| Component succeeds, no artifact | ⚠ Suspicious |

A system that fails loudly and leaves artifacts is healthier than one that succeeds silently.

---

## Operating Rules for Agents

### Rule 1: Capture Before Action

Before modifying state, capture an artifact of the current state. The artifact is your receipt.

```
1. Read current state → create snapshot artifact
2. Plan action → create decision artifact with dependencies
3. Execute action
4. Verify result → create verification artifact
```

### Rule 2: Chain Your Dependencies

Every artifact should reference the artifacts it depends on. This creates an auditable chain of causation.

```json
{
  "dependencies": [
    {"id": "abc123...", "relationship": "requires"},
    {"id": "def456...", "relationship": "extends"}
  ]
}
```

Orphan artifacts (no dependencies, no dependents) are suspicious. Reality is connected.

### Rule 3: Sign What You Assert

If you assert something as fact, sign it. Unsigned artifacts are observations; signed artifacts are assertions.

- System-generated traces: unsigned (objective observation)
- Agent decisions: signed (subjective assertion)
- Proofs: signed by prover (mathematical assertion)

### Rule 4: Verify Before Trust

Never trust an artifact without verification:

1. Check the content hash matches the claimed content
2. Check the ID matches the canonical hash
3. Verify all required dependencies exist
4. Validate signatures if present

Trust is earned through cryptographic verification, not origin.

### Rule 5: Preserve the Chain

When modifying or superseding artifacts:

- Never delete artifacts (mark as superseded instead)
- Always reference what you're replacing
- Maintain the complete history

The past cannot be changed, only interpreted with new evidence.

---

## The Three Forks

### Linux Fork: What Happened

The kernel sees all. ftrace hooks, eBPF probes, and firmware traces capture the raw events of industrial reality. This is the ground truth layer.

**Responsibility**: Observe without judgment. Capture everything. Miss nothing.

### Geth Fork: What Was Proven

Ethereum proofs provide mathematical certainty. Zero-knowledge proofs verify without revealing. State diffs show exactly what changed.

**Responsibility**: Prove what matters. Verify what's claimed. Trust nothing unproven.

### Agentic-QE Fork: Why It Was Decided

Agent reasoning traces, embeddings, and world models capture the decision-making process. This is the layer of intent made explicit.

**Responsibility**: Explain your reasoning. Show your work. Enable replay.

---

## Failure Modes and Responses

### Missing Artifact
**Symptom**: Expected artifact not found
**Response**: Halt and investigate. Do not proceed without evidence.

### Hash Mismatch
**Symptom**: Computed hash ≠ claimed hash
**Response**: Reject artifact. Treat as potential tampering.

### Broken Dependency Chain
**Symptom**: Dependency artifact not found or invalid
**Response**: Quarantine dependent artifacts. Trace the break.

### Unsigned Critical Decision
**Symptom**: Agent decision without signature
**Response**: Flag for review. Decision is unattributable.

---

## Aphorisms

> "Reality leaves traces. Capture them."

> "The best time to create an artifact was before the action. The second best time is now."

> "In disagreement between memory and artifacts, artifacts win."

> "An agent without artifacts is just software with opinions."

> "The artifact chain is the chain of custody for reality."

---

## Implementation Checklist

- [ ] All agent actions create pre/post artifacts
- [ ] All decisions reference input artifacts
- [ ] All critical assertions are signed
- [ ] All artifacts have human-readable summaries
- [ ] Artifact verification runs on every load
- [ ] Dependency chains are validated before trust
- [ ] Failed verifications trigger alerts
- [ ] The artifact chain can be replayed from genesis

---

*This doctrine governs all agents operating within the 0xSCADA Reality Artifact ecosystem. Compliance is not optional—it is the price of participation in shared reality.*
