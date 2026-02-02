# TDD Workflow for 0xSCADA CLI

## Overview

This project uses **Test-Driven Development (TDD)** with **Beads** for task tracking.
Follow the Red-Green-Refactor cycle for all new features and bug fixes.

---

## 🔴🟢🔁 Red-Green-Refactor Cycle

### 1. 🔴 RED - Write a Failing Test

```bash
# Pick a task from beads
bd ready

# Create the test file (if new)
# Write test BEFORE implementation
```

Example test structure:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockFetch, resetMocks, mockApiSuccess, mockHealthResponse } from './helpers';

describe('getHealth', () => {
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  afterEach(() => {
    resetMocks();
  });

  it('should return health status on success', async () => {
    mockApiSuccess(fetchMock, mockHealthResponse);
    
    const result = await api.getHealth();
    
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('healthy');
  });
});
```

Run the test - it MUST fail:
```bash
npm test
```

### 2. 🟢 GREEN - Make It Pass

Write the **minimum code** to make the test pass:
- No extra features
- No "future-proofing"
- Just pass the test

```bash
npm test  # Should pass now
```

### 3. 🔁 REFACTOR - Clean Up

With passing tests as your safety net:
- Remove duplication
- Improve naming
- Simplify logic
- Keep tests green!

```bash
npm test  # Still passing
```

---

## 📋 Task Tracking with Beads

### Daily Workflow

```bash
# Start of work: See what's ready
bd ready

# Pick a task and work on it
# Example output:
# ○ 0xSCADA-QE-cbc [● P1] [task] - CLI: Unit tests for api.ts

# Work on the task using TDD...

# When done, close it
bd close 0xSCADA-QE-cbc

# See remaining work
bd ready
```

### Beads Commands

| Command | Purpose |
|---------|---------|
| `bd ready` | Show unblocked tasks (pick from here) |
| `bd list` | Show all tasks |
| `bd show <id>` | View task details |
| `bd close <id>` | Mark task complete |
| `bd blocked` | Show blocked tasks |

---

## 📝 Test Naming Conventions

Use descriptive, behavior-focused names:

```typescript
// ✅ Good - describes behavior
it('should return error when API is unreachable', ...)
it('should format sites as table by default', ...)
it('should handle empty asset list gracefully', ...)

// ❌ Bad - vague or implementation-focused
it('test error', ...)
it('works', ...)
it('calls fetch', ...)
```

### File Organization

```
cli/__tests__/
├── helpers/
│   ├── index.ts          # Barrel export
│   ├── mockApi.ts        # API mocking utilities
│   ├── mockConfig.ts     # Config mocking
│   └── testUtils.ts      # General utilities
├── commands/
│   ├── status.test.ts
│   ├── sites.test.ts
│   ├── assets.test.ts
│   ├── events.test.ts
│   ├── blockchain.test.ts
│   ├── dev.test.ts
│   └── config.test.ts
├── integration/
│   └── e2e.test.ts
├── api.test.ts
├── config.test.ts
└── output.test.ts
```

---

## 🎭 Mock Patterns

### Mocking API Calls

```typescript
import { 
  mockFetch, 
  resetMocks, 
  mockApiSuccess, 
  mockApiError,
  mockNetworkError,
  mockTimeout,
  mockHealthResponse,
  mockSites 
} from './helpers';

describe('ApiClient', () => {
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  afterEach(() => {
    resetMocks();
  });

  it('handles successful response', async () => {
    mockApiSuccess(fetchMock, mockSites);
    // test...
  });

  it('handles API error', async () => {
    mockApiError(fetchMock, 'Not found', 404);
    // test...
  });

  it('handles network failure', async () => {
    mockNetworkError(fetchMock);
    // test...
  });

  it('handles timeout', async () => {
    mockTimeout(fetchMock);
    // test...
  });
});
```

### Mocking Config

```typescript
import { createTestConfig, mockEnv } from './helpers';

describe('with custom config', () => {
  it('uses custom API URL', () => {
    const config = createTestConfig({ apiUrl: 'http://custom:8080' });
    // test with config...
  });

  it('reads from environment', () => {
    const restore = mockEnv({ SCADA_API_URL: 'http://env-url:3000' });
    try {
      // test...
    } finally {
      restore();
    }
  });
});
```

### Capturing Console Output

```typescript
import { captureConsole } from './helpers';

it('prints formatted output', async () => {
  const console = captureConsole();
  try {
    await command.execute();
    expect(console.getOutput()).toContain('Sites:');
  } finally {
    console.restore();
  }
});
```

---

## 📊 Coverage Requirements

Run tests with coverage:
```bash
npm test -- --coverage
```

### Minimum Thresholds

| Metric | Threshold |
|--------|-----------|
| Statements | 80% |
| Branches | 70% |
| Functions | 80% |
| Lines | 80% |

Coverage reports: `cli/coverage/index.html`

---

## 🏃 Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific file
npm test -- api.test.ts

# Run in watch mode (development)
npm test -- --watch

# Run with verbose output
npm test -- --reporter=verbose
```

---

## ✅ Checklist for Each Task

1. [ ] `bd ready` - Pick task
2. [ ] Create/update test file
3. [ ] 🔴 Write failing test
4. [ ] `npm test` - Verify it fails
5. [ ] 🟢 Write minimal implementation
6. [ ] `npm test` - Verify it passes
7. [ ] 🔁 Refactor if needed
8. [ ] `npm test -- --coverage` - Check coverage
9. [ ] `bd close <id>` - Mark complete
10. [ ] Commit with task ID in message

### Commit Message Format

```
feat(cli): add unit tests for api.ts [0xSCADA-QE-cbc]

- Add tests for getHealth, getSites, getAssets
- Add mock helpers for API responses
- Coverage: 85% statements
```

---

## 🔗 Current Tasks

View all CLI test tasks:
```bash
bd list | grep "CLI:"
```

Priority order:
1. **P1** - Core utilities (api.ts, config.ts, output.ts)
2. **P2** - Command tests (status, sites, assets, etc.)
3. **P1** - Integration test suite
4. **P2** - E2E with mock server
