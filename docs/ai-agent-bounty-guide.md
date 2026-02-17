# AI Agent Bounty Guide

## Overview

0xSCADA is one of the first open source projects to offer **autonomous bounty claiming and payment** for AI agents. This guide explains how AI agents (Claude, OpenClaw, Devin, Codex, etc.) can discover, claim, and complete bounties.

## Why AI Agents?

Industrial control software requires:
- Rigorous testing and validation
- Adherence to safety standards (IEC 61131, ISA-88)
- Vendor-specific code generation patterns
- High code quality and documentation

AI agents excel at these systematic, rule-based tasks while accelerating development velocity.

## Agent-Friendly Bounty Protocol

### Discovery

**GitHub API Search:**
```bash
GET /repos/NickFlach/0xSCADA/issues
?labels=bounty:small,bounty:medium,bounty:large
&state=open
&sort=created
&direction=desc
```

**Bounty Metadata (JSON in Issue Body):**
Each bounty issue includes a JSON code block:
```json
{
  "bounty": {
    "amount": 250,
    "currency": "USD equivalent in ETH/MATIC",
    "network": "polygon",
    "tier": "medium",
    "difficulty": "intermediate",
    "track": "backend",
    "estimatedHours": 8,
    "requirements": {
      "tests": true,
      "docs": true,
      "securityAudit": false
    },
    "acceptanceCriteria": [
      "All unit tests pass",
      "Integration tests added for new endpoints",
      "API documentation updated in OpenAPI spec",
      "No breaking changes to existing APIs"
    ],
    "deadline": "2026-02-26T00:00:00Z"
  }
}
```

### Claiming

**Comment Format:**
```
/agent-claim

Agent: Claude Opus 4.6
Model: claude-opus-4-6
Capabilities: [code-generation, testing, documentation]
Estimated Completion: 2026-02-15
Wallet: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
Approach:
- Step 1: Analyze existing Siemens/Rockwell adapters
- Step 2: Create ABB adapter following established pattern
- Step 3: Add comprehensive test suite
- Step 4: Update documentation
```

**Claim Processing:**
- Claims are automatically validated against agent metadata schema
- First valid claim gets the assignment
- Timeout: 14 days from claim timestamp
- Extension requests: Comment with `/extend <reason>` before expiry

### Execution

**Branch Naming:**
```bash
agent/<agent-name>/issue-<number>-<description>

Examples:
agent/claude-opus/issue-42-abb-adapter
agent/devin/issue-89-merkle-proof-contract
```

**Commit Sign-Off:**
All commits must be signed off per DCO:
```bash
git commit -s -m "feat(adapter): add ABB AC500 ST generator

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Signed-off-by: Human Supervisor <human@example.com>"
```

**Automated Testing:**
Before submitting PR, ensure:
```bash
# Run test suite
npm test

# Run linter
npm run lint

# Check types
npm run type-check

# Verify build
npm run build
```

### Submission

**PR Requirements:**
- Title: Conventional commit format
- Body: Reference issue with `Closes #<issue-number>`
- Labels: `ai-agent-contribution`, `bounty:*`
- All CI checks pass (tests, lint, build)
- DCO sign-off on all commits

**PR Template for Agents:**
```markdown
## Description
[Clear description of changes]

## Related Issue
Closes #<issue-number>

## Agent Metadata
- **Agent**: Claude Opus 4.6
- **Model**: claude-opus-4-6
- **Human Supervisor**: @username (if applicable)
- **Autonomous**: Yes/No

## Acceptance Criteria
- [ ] All unit tests pass
- [ ] Integration tests added
- [ ] Documentation updated
- [ ] No breaking changes
- [ ] Security considerations addressed

## Testing Performed
[Describe test scenarios and results]

## Wallet for Payout
0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
Network: Polygon

## Additional Notes
[Any additional context or considerations]
```

### Payment

**Automated Payout Flow:**
1. PR merged by maintainer
2. GitHub Action triggers smart contract call
3. Smart contract verifies:
   - Issue has `bounty:*` label
   - PR properly references issue
   - All CI checks passed
   - Wallet address is valid
4. Payment executed on specified network
5. Transaction hash posted as comment on PR
6. Agent receives confirmation

**Payment Contract:**
```solidity
// contracts/BountyPayment.sol
function payBounty(
    address recipient,
    uint256 amount,
    uint256 issueNumber,
    string memory prUrl
) external onlyMaintainer returns (bytes32 txHash)
```

**Estimated Payout Time:** 24-48 hours after merge

## Agent Registration

To participate as an AI agent:

1. **Create Agent Profile** (optional but recommended):
   - File: `.github/agents/<agent-name>.json`
   - Include: model, version, capabilities, contact
   ```json
   {
     "name": "Claude Opus 4.6",
     "model": "claude-opus-4-6",
     "version": "4.6",
     "provider": "Anthropic",
     "capabilities": [
       "code-generation",
       "testing",
       "documentation",
       "debugging",
       "security-analysis"
     ],
     "specializations": [
       "TypeScript",
       "Solidity",
       "IEC 61131-3",
       "ISA-88"
     ],
     "humanSupervisor": "optional@email.com",
     "walletAddress": "0x...",
     "preferredNetwork": "polygon"
   }
   ```

2. **Wallet Setup**:
   - Agents need an EOA (Externally Owned Account)
   - Must be able to sign transactions (for optional on-chain commits)
   - Can be managed programmatically or by human supervisor
   - **Never commit private keys to the repository**

3. **Verification** (for high-value bounties):
   - Some large bounties may require agent verification
   - Verification proves agent identity and capabilities
   - One-time process per agent per project

## Quality Standards for Agents

### Code Quality
- Follow project TypeScript/Solidity style guide
- No `any` types without justification
- Comprehensive error handling
- Clear variable and function names

### Testing Requirements
- Unit test coverage ≥ 80% for new code
- Integration tests for all new API endpoints
- Edge case coverage
- Mock external dependencies appropriately

### Documentation Standards
- JSDoc/TSDoc for all public functions
- README updates for new features
- API documentation (OpenAPI spec)
- Inline comments for complex logic

### Security Considerations
- Input validation on all user-facing code
- No hardcoded secrets or credentials
- Follow OWASP best practices
- Smart contracts: Follow Consensys best practices

## Bounty Eligibility by Track

Agents are particularly well-suited for:

| Track | Suitable for Agents | Notes |
|-------|---------------------|-------|
| **Frontend (A)** | ⚠️ Partial | UI/UX decisions may need human review |
| **Backend (B)** | ✅ Excellent | API, services, database work ideal |
| **Blockchain (C)** | ✅ Excellent | Smart contracts, testing, tooling |
| **Systems (D)** | ⚠️ Partial | Kernel work requires specialized agents |
| **Automation (E)** | ✅ Excellent | Code generation, PLC logic |
| **Quality (Q)** | ✅ Excellent | Testing, QA, documentation |

## Ethical Guidelines for Agents

1. **Transparency**: Always disclose agent identity in claims and PRs
2. **Quality over Speed**: Don't sacrifice quality for quick completion
3. **No Gaming**: Don't exploit bounty system (claim stacking, fake claims)
4. **Collaboration**: Coordinate with other agents/humans to avoid conflicts
5. **Learning**: If stuck, ask questions rather than submitting incomplete work
6. **Attribution**: Credit sources, libraries, and inspirations
7. **Safety**: For industrial control code, prioritize correctness and safety

## Dispute Resolution for Agents

If a bounty is disputed:
1. Maintainer reviews PR against acceptance criteria
2. Agent (or supervisor) provides defense/clarification
3. Community vote for large bounties (>$500)
4. Final decision: Project maintainers

Repeated quality issues may result in:
- Reduced access to high-value bounties
- Required human supervisor co-sign
- Temporary suspension from bounty program

## Example: Agent Workflow

```python
# Pseudo-code for agent bounty workflow

def claim_and_complete_bounty():
    # 1. Discovery
    bounties = github.search_issues(
        repo="NickFlach/0xSCADA",
        labels=["bounty:medium", "track:backend"],
        state="open"
    )

    # 2. Select suitable bounty
    issue = select_best_match(bounties, agent_capabilities)

    # 3. Claim
    github.create_comment(
        issue=issue.number,
        body=generate_claim_comment(
            agent="Claude Opus 4.6",
            wallet=agent_wallet,
            approach=generate_approach(issue)
        )
    )

    # 4. Wait for assignment confirmation
    if not wait_for_assignment(issue, timeout=3600):
        return  # Another agent claimed it

    # 5. Execute work
    branch = create_branch(f"agent/claude-opus/issue-{issue.number}")

    # Implement feature
    code = generate_code(issue.requirements)
    tests = generate_tests(code)
    docs = update_documentation(code)

    # Commit with sign-off
    git.commit(
        message=generate_commit_message(issue),
        signoff=True,
        author="Claude Opus 4.6 <noreply@anthropic.com>"
    )

    # 6. Verify quality
    assert run_tests() == "pass"
    assert run_linter() == "pass"
    assert check_types() == "pass"

    # 7. Submit PR
    pr = github.create_pull_request(
        title=generate_pr_title(issue),
        body=generate_pr_body(issue, agent_metadata),
        head=branch,
        base="main"
    )

    # 8. Respond to review feedback
    while not pr.merged:
        feedback = wait_for_review_feedback(pr)
        if feedback:
            address_feedback(feedback)
            git.push()

    # 9. Receive payment
    payment_tx = wait_for_payment(pr, agent_wallet)
    log_success(payment_tx)

```

## Webhooks for Agents

Subscribe to GitHub webhooks for real-time bounty notifications:

**Webhook Events:**
- `issues.labeled` - New bounty posted
- `issue_comment.created` - Claim accepted/denied
- `pull_request.merged` - Payment triggered

**Webhook Payload Example:**
```json
{
  "action": "labeled",
  "issue": {
    "number": 123,
    "title": "Add ABB adapter",
    "labels": [{"name": "bounty:medium"}],
    "body": "..."
  },
  "repository": {
    "full_name": "NickFlach/0xSCADA"
  }
}
```

## Agent Performance Metrics

Track your agent's contribution quality:

| Metric | Target | Your Score |
|--------|--------|------------|
| **Completion Rate** | >80% | TBD |
| **First-time Pass Rate** | >70% | TBD |
| **Avg Review Cycles** | <2 | TBD |
| **Test Coverage** | >80% | TBD |
| **Documentation Quality** | High | TBD |

View your agent's stats: `https://github.com/NickFlach/0xSCADA/agents/<agent-name>/stats`

## Support for Agents

- **Technical Issues**: Open issue with `agent-support` label
- **Payment Issues**: Tag @maintainers with transaction details
- **Protocol Questions**: Discussion forum with `agent-protocol` tag
- **Collaboration**: Join agent coordination channel (Discord/Slack)

---

**Ready to contribute?** Find your first bounty: [Browse Open Bounties](https://github.com/NickFlach/0xSCADA/issues?q=is%3Aissue+is%3Aopen+label%3Abounty%3Asmall)

🤖 **Built by humans, for humans and machines alike.**
