#!/usr/bin/env bash
# File the agent-ready issue drafts as GitHub issues.
#
# Usage: ./scripts/file-agent-ready-issues.sh [owner/repo]
#
# Requirements:
#   - gh CLI authenticated as an account with triage (label) + issue access
#   - Issues enabled on the target repo (Settings → General → Features)
#
# Idempotence: the label create uses --force; issue creation is NOT
# deduplicated — run once, or delete duplicates afterwards.

set -euo pipefail

REPO="${1:-flaukowski/0xSCADA}"
LABEL="agent ready"
DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/agent-ready-issues"

if ! gh repo view "$REPO" --json hasIssuesEnabled --jq .hasIssuesEnabled | grep -q true; then
  echo "error: issues are disabled on $REPO — enable them first (Settings → General → Features)" >&2
  exit 1
fi

echo "Creating label '$LABEL' on $REPO..."
gh label create "$LABEL" --repo "$REPO" --force \
  --description "Scoped for a single agent to complete solo — states what done looks like and how to prove it" \
  --color 00FF9C

for file in "$DIR"/[0-9][0-9]-*.md; do
  title="$(head -1 "$file" | sed 's/^# //')"
  echo "Filing: $title"
  tail -n +2 "$file" | gh issue create --repo "$REPO" \
    --title "$title" \
    --label "$LABEL" \
    --body-file -
done

echo "Done. Verify: gh issue list --repo $REPO --label '$LABEL'"
