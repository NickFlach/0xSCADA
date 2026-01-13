#!/bin/bash
# OxSCADA GitHub Project Setup Script
# This script sets up labels, milestones, and starter issues for the OxSCADA project

set -e

echo "🏭 OxSCADA GitHub Project Setup"
echo "================================"

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is not installed. Please install it first:"
    echo "   https://cli.github.com/manual/installation"
    exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo "❌ Not authenticated with GitHub. Please run: gh auth login"
    exit 1
fi

# Get repository info
REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
    echo "❌ Not in a GitHub repository or repo not configured"
    exit 1
fi

echo "📦 Repository: $REPO"
echo ""

# Function to create labels
create_labels() {
    echo "🏷️  Setting up labels..."

    # Track labels
    gh label create "track:frontend" --color "7057ff" --description "Track A: Frontend Engineering" --force 2>/dev/null || true
    gh label create "track:backend" --color "0e8a16" --description "Track B: Backend Engineering" --force 2>/dev/null || true
    gh label create "track:blockchain" --color "fbca04" --description "Track C: Blockchain Engineering" --force 2>/dev/null || true
    gh label create "track:systems" --color "d93f0b" --description "Track D: Systems Engineering" --force 2>/dev/null || true
    gh label create "track:automation" --color "006b75" --description "Track E: Industrial Automation" --force 2>/dev/null || true
    gh label create "track:quality" --color "1d76db" --description "Track Q: Quality Engineering" --force 2>/dev/null || true

    # Difficulty labels
    gh label create "difficulty:beginner" --color "c5def5" --description "Level 1 - Foundation" --force 2>/dev/null || true
    gh label create "difficulty:intermediate" --color "bfd4f2" --description "Level 2 - Core Competency" --force 2>/dev/null || true
    gh label create "difficulty:advanced" --color "d4c5f9" --description "Level 3 - Advanced" --force 2>/dev/null || true
    gh label create "difficulty:expert" --color "e99695" --description "Level 4 - Expert" --force 2>/dev/null || true

    # Phase labels
    gh label create "phase:6-realtime" --color "0052cc" --description "Phase 6: Real-Time Industrial Communication" --force 2>/dev/null || true
    gh label create "phase:7-batch" --color "5319e7" --description "Phase 7: ISA-88 Batch Runtime" --force 2>/dev/null || true
    gh label create "phase:8-hmi" --color "b60205" --description "Phase 8: HMI/SCADA Visualization" --force 2>/dev/null || true
    gh label create "phase:9-os" --color "d93f0b" --description "Phase 9: OxSCADA Operating System" --force 2>/dev/null || true
    gh label create "phase:10-decentralized" --color "0e8a16" --description "Phase 10: Decentralized Network" --force 2>/dev/null || true
    gh label create "phase:11-ai" --color "006b75" --description "Phase 11: AI & Digital Twins" --force 2>/dev/null || true

    # Type labels
    gh label create "type:feature" --color "a2eeef" --description "New feature or enhancement" --force 2>/dev/null || true
    gh label create "type:bugfix" --color "d73a4a" --description "Bug fix" --force 2>/dev/null || true
    gh label create "type:docs" --color "0075ca" --description "Documentation" --force 2>/dev/null || true
    gh label create "type:test" --color "e4e669" --description "Test coverage" --force 2>/dev/null || true
    gh label create "type:refactor" --color "fef2c0" --description "Code refactoring" --force 2>/dev/null || true
    gh label create "type:security" --color "b60205" --description "Security related" --force 2>/dev/null || true

    # Status labels
    gh label create "status:ready" --color "0e8a16" --description "Ready to start" --force 2>/dev/null || true
    gh label create "status:blocked" --color "d93f0b" --description "Blocked by dependency" --force 2>/dev/null || true
    gh label create "epic" --color "3e4b9e" --description "Large initiative with sub-issues" --force 2>/dev/null || true

    echo "✅ Labels created"
}

# Function to create milestones
create_milestones() {
    echo ""
    echo "🎯 Setting up milestones..."

    gh api repos/$REPO/milestones -f title="v2.1.0-realtime" -f description="Phase 6: Real-Time Industrial Communication" -f due_on="2026-03-31T00:00:00Z" 2>/dev/null || true
    gh api repos/$REPO/milestones -f title="v2.2.0-batch" -f description="Phase 7: ISA-88 Batch Runtime Engine" -f due_on="2026-06-30T00:00:00Z" 2>/dev/null || true
    gh api repos/$REPO/milestones -f title="v2.3.0-hmi" -f description="Phase 8: HMI/SCADA Visualization Suite" -f due_on="2026-09-30T00:00:00Z" 2>/dev/null || true
    gh api repos/$REPO/milestones -f title="v3.0.0-os" -f description="Phase 9: OxSCADA Operating System" -f due_on="2026-12-31T00:00:00Z" 2>/dev/null || true
    gh api repos/$REPO/milestones -f title="v3.1.0-decentralized" -f description="Phase 10: Decentralized Network & Governance" -f due_on="2027-03-31T00:00:00Z" 2>/dev/null || true
    gh api repos/$REPO/milestones -f title="v3.2.0-ai" -f description="Phase 11: AI & Digital Twins" -f due_on="2027-06-30T00:00:00Z" 2>/dev/null || true

    echo "✅ Milestones created"
}

# Function to create starter issues
create_starter_issues() {
    echo ""
    echo "📝 Creating starter issues..."
    echo "   (This will create good-first-issues for each learning track)"

    read -p "Create starter issues? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping issue creation"
        return
    fi

    # Frontend Track - Beginner
    gh issue create \
        --title "[Track A1.1] Create Tag Status Card Component" \
        --body "## Learning Track Issue

**Track:** A - Frontend Engineering
**Level:** Beginner (Foundation)
**Phase:** Infrastructure

### Description
Create a reusable TagStatusCard component that displays an industrial tag's name, value, unit, and status indicator.

### Learning Objectives
- React functional components
- TypeScript props interfaces
- TailwindCSS styling basics
- shadcn/ui Card component usage

### Acceptance Criteria
- [ ] Component accepts tag data as props
- [ ] Displays tag name, current value, and engineering unit
- [ ] Shows color-coded status indicator (green/yellow/red)
- [ ] Responsive design using TailwindCSS
- [ ] TypeScript interfaces for all props

### Hints
- Look at \`client/src/components/ui/card.tsx\` for component patterns
- Use the existing color scheme from \`client/src/index.css\`

**Estimated Effort:** 2-4 hours" \
        --label "track:frontend" \
        --label "difficulty:beginner" \
        --label "good-first-issue" \
        --label "component:client" 2>/dev/null || true

    # Backend Track - Beginner
    gh issue create \
        --title "[Track B1.1] Add Pagination to Events API" \
        --body "## Learning Track Issue

**Track:** B - Backend Engineering
**Level:** Beginner (Foundation)
**Phase:** Infrastructure

### Description
Add cursor-based pagination to the GET /api/events endpoint to handle large event volumes efficiently.

### Learning Objectives
- Express route handlers
- SQL LIMIT/OFFSET pagination
- Drizzle ORM query building
- API response formatting

### Acceptance Criteria
- [ ] Accept page and limit query parameters
- [ ] Return total count in response
- [ ] Include next/prev page indicators
- [ ] Default to 50 items per page

### Hints
- Look at \`server/routes.ts\` for existing patterns
- Use Drizzle's \`.limit()\` and \`.offset()\` methods

**Estimated Effort:** 2-3 hours" \
        --label "track:backend" \
        --label "difficulty:beginner" \
        --label "good-first-issue" \
        --label "component:server" 2>/dev/null || true

    # Quality Track - Beginner
    gh issue create \
        --title "[Track Q1.1] Add Integration Tests for Sites API" \
        --body "## Learning Track Issue

**Track:** Q - Quality Engineering
**Level:** Beginner (Foundation)
**Phase:** Infrastructure

### Description
Create integration tests for the Sites CRUD API endpoints using real database queries.

### Learning Objectives
- Vitest test framework
- API integration testing
- Test database setup/teardown
- Supertest for HTTP testing

### Acceptance Criteria
- [ ] Test GET /api/sites returns all sites
- [ ] Test POST /api/sites creates new site
- [ ] Test PUT /api/sites/:id updates site
- [ ] Test DELETE /api/sites/:id removes site
- [ ] Uses real database, not mocks

### Hints
- Use beforeEach to seed test data
- Clean up after tests with afterEach

**Estimated Effort:** 3-4 hours" \
        --label "track:quality" \
        --label "difficulty:beginner" \
        --label "good-first-issue" \
        --label "type:test" 2>/dev/null || true

    echo "✅ Starter issues created"
}

# Main execution
echo ""
echo "This script will set up:"
echo "  1. GitHub labels for learning tracks, difficulty, phases, and types"
echo "  2. Milestones for each roadmap phase"
echo "  3. Starter issues for new contributors (optional)"
echo ""

read -p "Continue? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted"
    exit 0
fi

create_labels
create_milestones
create_starter_issues

echo ""
echo "🎉 GitHub project setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review labels: gh label list"
echo "  2. Review milestones: gh api repos/$REPO/milestones"
echo "  3. View issues: gh issue list"
echo "  4. Create a GitHub Project board for tracking"
echo ""
echo "See docs/ROADMAP.md for the full roadmap and learning tracks."
