# Bounty Metadata Schema

## Overview

This document defines the machine-readable metadata format for bounties, enabling AI agents to autonomously discover, evaluate, and claim bounties.

## JSON Schema

### Bounty Metadata Structure

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "0xSCADA Bounty Metadata",
  "type": "object",
  "required": ["bounty", "acceptance_criteria", "technical_requirements"],
  "properties": {
    "bounty": {
      "type": "object",
      "required": ["amount", "currency", "network", "tier", "difficulty"],
      "properties": {
        "amount": {
          "type": "number",
          "description": "Bounty amount in USD",
          "minimum": 0
        },
        "currency": {
          "type": "string",
          "description": "Payment currency",
          "enum": ["MATIC", "ETH", "USDC", "DAI", "USD_EQUIVALENT"]
        },
        "network": {
          "type": "string",
          "description": "Blockchain network for payment",
          "enum": ["polygon", "arbitrum", "optimism", "base", "ethereum"]
        },
        "tier": {
          "type": "string",
          "description": "Bounty tier",
          "enum": ["small", "medium", "large", "xl"]
        },
        "difficulty": {
          "type": "string",
          "description": "Technical difficulty level",
          "enum": ["beginner", "intermediate", "advanced", "expert"]
        },
        "track": {
          "type": "string",
          "description": "Learning track",
          "enum": ["frontend", "backend", "blockchain", "systems", "automation", "quality"]
        },
        "estimated_hours": {
          "type": "number",
          "description": "Estimated completion time in hours",
          "minimum": 0
        },
        "deadline": {
          "type": "string",
          "format": "date-time",
          "description": "Optional deadline (ISO 8601 format)"
        },
        "agent_friendly": {
          "type": "boolean",
          "description": "Can AI agents autonomously complete this bounty?"
        },
        "requires_human_review": {
          "type": "boolean",
          "description": "Does this require human judgment/review?"
        },
        "collaborative": {
          "type": "boolean",
          "description": "Can multiple contributors collaborate?"
        }
      }
    },
    "acceptance_criteria": {
      "type": "array",
      "description": "List of acceptance criteria that must be met",
      "items": {
        "type": "object",
        "required": ["description", "automated", "required"],
        "properties": {
          "description": {
            "type": "string",
            "description": "Human-readable criterion description"
          },
          "automated": {
            "type": "boolean",
            "description": "Can this be automatically verified?"
          },
          "required": {
            "type": "boolean",
            "description": "Is this criterion mandatory?"
          },
          "verification_method": {
            "type": "string",
            "description": "How to verify (test_suite, linter, manual_review, etc.)"
          },
          "threshold": {
            "type": "object",
            "description": "Quantitative threshold (e.g., test coverage %)",
            "properties": {
              "metric": {"type": "string"},
              "operator": {"type": "string", "enum": [">=", ">", "<=", "<", "=="]},
              "value": {"type": "number"}
            }
          }
        }
      }
    },
    "technical_requirements": {
      "type": "object",
      "description": "Technical specifications and constraints",
      "properties": {
        "languages": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Programming languages required"
        },
        "frameworks": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Frameworks/libraries required"
        },
        "test_coverage_min": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "description": "Minimum test coverage percentage"
        },
        "breaking_changes_allowed": {
          "type": "boolean",
          "description": "Can this introduce breaking changes?"
        },
        "security_audit_required": {
          "type": "boolean",
          "description": "Does this need security review?"
        },
        "performance_benchmarks": {
          "type": "array",
          "description": "Performance benchmarks to meet",
          "items": {
            "type": "object",
            "properties": {
              "metric": {"type": "string"},
              "target": {"type": "number"},
              "unit": {"type": "string"}
            }
          }
        }
      }
    },
    "resources": {
      "type": "array",
      "description": "Links to documentation, examples, related issues",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["documentation", "example", "issue", "pr", "external"]
          },
          "url": {"type": "string", "format": "uri"},
          "description": {"type": "string"}
        }
      }
    },
    "agent_metadata": {
      "type": "object",
      "description": "Agent-specific metadata",
      "properties": {
        "recommended_models": {
          "type": "array",
          "items": {"type": "string"},
          "description": "AI models recommended for this task"
        },
        "required_capabilities": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Capabilities required (code-gen, testing, docs, etc.)"
        },
        "context_size_estimate": {
          "type": "number",
          "description": "Estimated context size needed (tokens)"
        },
        "multi_step": {
          "type": "boolean",
          "description": "Does this require multiple agentic steps?"
        }
      }
    }
  }
}
```

## Example Bounty Metadata

### Small Bounty Example

```json
{
  "bounty": {
    "amount": 100,
    "currency": "USD_EQUIVALENT",
    "network": "polygon",
    "tier": "small",
    "difficulty": "beginner",
    "track": "backend",
    "estimated_hours": 3,
    "agent_friendly": true,
    "requires_human_review": false,
    "collaborative": false
  },
  "acceptance_criteria": [
    {
      "description": "All unit tests pass",
      "automated": true,
      "required": true,
      "verification_method": "test_suite",
      "threshold": {
        "metric": "tests_passed",
        "operator": "==",
        "value": 100
      }
    },
    {
      "description": "Code follows ESLint rules",
      "automated": true,
      "required": true,
      "verification_method": "linter"
    },
    {
      "description": "API documentation updated",
      "automated": false,
      "required": true,
      "verification_method": "manual_review"
    }
  ],
  "technical_requirements": {
    "languages": ["TypeScript"],
    "frameworks": ["Express", "Drizzle ORM"],
    "test_coverage_min": 80,
    "breaking_changes_allowed": false,
    "security_audit_required": false
  },
  "resources": [
    {
      "type": "example",
      "url": "https://github.com/NickFlach/0xSCADA/blob/main/server/routes.ts",
      "description": "Existing API routes pattern"
    },
    {
      "type": "documentation",
      "url": "https://github.com/NickFlach/0xSCADA/blob/main/docs/API.md",
      "description": "API documentation guidelines"
    }
  ],
  "agent_metadata": {
    "recommended_models": ["claude-opus-4-6", "gpt-4", "devin"],
    "required_capabilities": ["code-generation", "testing", "documentation"],
    "context_size_estimate": 50000,
    "multi_step": false
  }
}
```

### Large Bounty Example (Smart Contract)

```json
{
  "bounty": {
    "amount": 1000,
    "currency": "USD_EQUIVALENT",
    "network": "polygon",
    "tier": "large",
    "difficulty": "advanced",
    "track": "blockchain",
    "estimated_hours": 20,
    "deadline": "2026-03-15T00:00:00Z",
    "agent_friendly": true,
    "requires_human_review": true,
    "collaborative": false
  },
  "acceptance_criteria": [
    {
      "description": "All unit tests pass with 100% coverage",
      "automated": true,
      "required": true,
      "verification_method": "test_suite",
      "threshold": {
        "metric": "test_coverage",
        "operator": ">=",
        "value": 100
      }
    },
    {
      "description": "No high/critical Slither findings",
      "automated": true,
      "required": true,
      "verification_method": "security_scanner"
    },
    {
      "description": "Gas optimization: deploy cost < 2M gas",
      "automated": true,
      "required": true,
      "verification_method": "gas_reporter",
      "threshold": {
        "metric": "deploy_gas",
        "operator": "<",
        "value": 2000000
      }
    },
    {
      "description": "Security audit by certified auditor",
      "automated": false,
      "required": true,
      "verification_method": "external_audit"
    },
    {
      "description": "NatSpec documentation for all functions",
      "automated": true,
      "required": true,
      "verification_method": "documentation_coverage"
    }
  ],
  "technical_requirements": {
    "languages": ["Solidity"],
    "frameworks": ["Hardhat", "OpenZeppelin"],
    "test_coverage_min": 100,
    "breaking_changes_allowed": false,
    "security_audit_required": true,
    "performance_benchmarks": [
      {
        "metric": "deployment_gas",
        "target": 2000000,
        "unit": "gas"
      },
      {
        "metric": "average_transaction_gas",
        "target": 100000,
        "unit": "gas"
      }
    ]
  },
  "resources": [
    {
      "type": "documentation",
      "url": "https://docs.openzeppelin.com/contracts/",
      "description": "OpenZeppelin Contracts documentation"
    },
    {
      "type": "example",
      "url": "https://github.com/NickFlach/0xSCADA/blob/main/contracts/IndustrialRegistry.sol",
      "description": "Similar contract pattern"
    },
    {
      "type": "external",
      "url": "https://eips.ethereum.org/EIPS/eip-4844",
      "description": "EIP-4844 blob transactions spec"
    }
  ],
  "agent_metadata": {
    "recommended_models": ["claude-opus-4-6", "gpt-4"],
    "required_capabilities": [
      "solidity-development",
      "testing",
      "security-analysis",
      "gas-optimization",
      "documentation"
    ],
    "context_size_estimate": 150000,
    "multi_step": true
  }
}
```

## Embedding in GitHub Issues

### Location
Bounty metadata should be included in the issue body as a JSON code block:

````markdown
## Bounty Details

```json
{
  "bounty": {
    "amount": 250,
    ...
  },
  ...
}
```
````

### Parsing
Agents can extract metadata using:

```javascript
const issueBody = issue.body;
const jsonMatch = issueBody.match(/```json\n([\s\S]*?)\n```/);
if (jsonMatch) {
  const metadata = JSON.parse(jsonMatch[1]);
  // Validate against schema
  const isValid = validateBountyMetadata(metadata);
}
```

## GitHub Labels

In addition to JSON metadata, issues should have appropriate labels:

### Required Labels
- `bounty:small` / `bounty:medium` / `bounty:large` / `bounty:xl`
- `track:frontend` / `track:backend` / `track:blockchain` / etc.
- `difficulty:beginner` / `difficulty:intermediate` / `difficulty:advanced` / `difficulty:expert`

### Optional Labels
- `ai-agent-friendly` - Indicates agents can autonomously complete
- `bounty:claimed` - Currently claimed
- `bounty:paid` - Payment completed
- `requires-security-audit` - Needs security review
- `breaking-change` - Involves breaking changes

## Validation

### Schema Validation

Agents should validate metadata against the JSON schema:

```typescript
import Ajv from "ajv";
import bountySchema from "./bounty-metadata-schema.json";

const ajv = new Ajv();
const validate = ajv.compile(bountySchema);

function validateBountyMetadata(metadata: unknown): boolean {
  const valid = validate(metadata);
  if (!valid) {
    console.error("Validation errors:", validate.errors);
  }
  return valid;
}
```

### Required Fields Check

At minimum, bounties must have:
- `bounty.amount`
- `bounty.tier`
- `bounty.difficulty`
- `acceptance_criteria` (non-empty array)

## Discovery API

### GitHub API Query

Agents can discover bounties using GitHub's REST API:

```bash
GET /repos/NickFlach/0xSCADA/issues
?labels=bounty:small,bounty:medium,bounty:large
&state=open
&sort=created
&direction=desc
&per_page=100
```

### GraphQL Query

For more advanced querying:

```graphql
query {
  repository(owner: "NickFlach", name: "0xSCADA") {
    issues(
      first: 100
      filterBy: { labels: ["bounty:small", "bounty:medium", "bounty:large"], states: OPEN }
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        body
        labels(first: 20) {
          nodes {
            name
          }
        }
        createdAt
      }
    }
  }
}
```

### Filtering Agent-Friendly Bounties

```bash
GET /repos/NickFlach/0xSCADA/issues
?labels=bounty:small,bounty:medium,ai-agent-friendly
&state=open
&-label=bounty:claimed
```

## Acceptance Criteria Format

### Automated Criteria

Criteria that can be programmatically verified:

```json
{
  "description": "Test coverage >= 80%",
  "automated": true,
  "verification_method": "coverage_reporter",
  "threshold": {
    "metric": "line_coverage",
    "operator": ">=",
    "value": 80
  }
}
```

**Verification Methods:**
- `test_suite` - Run test suite, check pass/fail
- `linter` - Run ESLint/Pylint, check for violations
- `coverage_reporter` - Check coverage reports
- `security_scanner` - Run Slither, Snyk, etc.
- `gas_reporter` - Hardhat gas reporter
- `build` - Verify successful build
- `type_checker` - TypeScript/mypy type checking

### Manual Criteria

Criteria requiring human judgment:

```json
{
  "description": "Code is readable and well-structured",
  "automated": false,
  "required": true,
  "verification_method": "manual_review"
}
```

## Updates and Versioning

### Schema Version

The schema version is tracked in the `$schema` field:

```json
{
  "$schema": "https://github.com/NickFlach/0xSCADA/blob/main/docs/bounty-metadata-schema-v1.0.json"
}
```

### Backward Compatibility

- New optional fields can be added without breaking existing agents
- Required fields should never be removed
- Enum values can be extended but not removed

### Migration Guide

When schema changes:
1. Update schema version
2. Provide migration script for existing bounties
3. Maintain backward compatibility for 6 months
4. Document breaking changes in CHANGELOG

## Best Practices

### For Maintainers Creating Bounties

1. **Be Specific**: Provide clear, measurable acceptance criteria
2. **Include Context**: Link to examples and documentation
3. **Estimate Accurately**: Set realistic `estimated_hours`
4. **Agent-Friendly**: Mark as `agent_friendly` only if truly autonomous
5. **Validate**: Use schema validator before posting

### For Agents Consuming Metadata

1. **Validate**: Always validate against schema
2. **Check Labels**: Cross-reference JSON metadata with issue labels
3. **Respect Deadlines**: Honor `deadline` field
4. **Verify Capabilities**: Match `required_capabilities` against agent capabilities
5. **Estimate Context**: Check `context_size_estimate` against model limits

## Support

- **Schema Issues**: Open issue with `bounty-metadata` label
- **Validation Errors**: Check schema documentation and examples
- **Missing Fields**: Propose schema enhancement via PR

---

**Schema Version**: 1.0
**Last Updated**: 2026-02-12
**Maintained By**: 0xSCADA Core Team
