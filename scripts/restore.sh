#!/usr/bin/env bash
# 0xSCADA Restore Script
# Issue #53 — Disaster Recovery & Backup Strategy
#
# Usage:
#   ./scripts/restore.sh [latest|<path-to-backup>]
#   ./scripts/restore.sh --dry-run latest
#
# Environment variables:
#   BACKUP_DIR       — Backup location (default: /backups)
#   DATABASE_URL     — PostgreSQL connection string
#   ENCRYPTION_KEY   — AES-256 decryption key

set -euo pipefail

DRY_RUN=false
BACKUP_DIR="${BACKUP_DIR:-/backups}"
WORK_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Parse args
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  shift
fi

TARGET="${1:-latest}"

echo "=== 0xSCADA Restore ==="
echo "Target: ${TARGET}"
echo "Dry run: ${DRY_RUN}"

# ---------------------------------------------------------------------------
# Find backup
# ---------------------------------------------------------------------------
if [ "$TARGET" = "latest" ]; then
  ARCHIVE=$(ls -t "$BACKUP_DIR"/0xscada-*.tar.gz* 2>/dev/null | head -1)
  if [ -z "$ARCHIVE" ]; then
    echo "ERROR: No backups found in ${BACKUP_DIR}"
    exit 1
  fi
else
  ARCHIVE="$TARGET"
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: Backup not found: ${ARCHIVE}"
  exit 1
fi

echo "Restoring from: ${ARCHIVE}"
echo "Size: $(du -h "$ARCHIVE" | cut -f1)"

# ---------------------------------------------------------------------------
# Decrypt if needed
# ---------------------------------------------------------------------------
DECRYPTED="$ARCHIVE"
if [[ "$ARCHIVE" == *.enc ]]; then
  echo "Decrypting archive..."
  if [ -z "${ENCRYPTION_KEY:-}" ]; then
    echo "ERROR: ENCRYPTION_KEY required for encrypted backup"
    exit 1
  fi
  DECRYPTED="$WORK_DIR/backup.tar.gz"
  openssl enc -aes-256-cbc -d -salt -pbkdf2 \
    -in "$ARCHIVE" \
    -out "$DECRYPTED" \
    -pass "pass:${ENCRYPTION_KEY}"
  echo "  Decrypted"
fi

# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------
echo "Extracting archive..."
tar xzf "$DECRYPTED" -C "$WORK_DIR"
echo "  Extracted"

# List contents
echo "Contents:"
ls -la "$WORK_DIR"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
echo "Verifying backup integrity..."
VALID=true

if [ -f "$WORK_DIR/database.dump" ]; then
  echo "  ✅ Database dump found ($(du -h "$WORK_DIR/database.dump" | cut -f1))"
else
  echo "  ⚠️  No database dump"
fi

if [ -f "$WORK_DIR/config.tar.gz" ]; then
  echo "  ✅ Config archive found"
else
  echo "  ⚠️  No config archive"
fi

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "=== Dry run complete — no changes made ==="
  exit 0
fi

# ---------------------------------------------------------------------------
# Restore database
# ---------------------------------------------------------------------------
if [ -f "$WORK_DIR/database.dump" ]; then
  echo "Restoring database..."
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "  WARNING: DATABASE_URL not set, skipping database restore"
  else
    pg_restore --clean --if-exists \
      -d "$DATABASE_URL" \
      "$WORK_DIR/database.dump" || echo "  pg_restore completed with warnings"
    echo "  Database restored"
  fi
fi

# ---------------------------------------------------------------------------
# Restore config
# ---------------------------------------------------------------------------
if [ -f "$WORK_DIR/config.tar.gz" ]; then
  echo "Restoring configuration..."
  RESTORE_DIR="${RESTORE_DIR:-$(dirname "$0")/..}"
  tar xzf "$WORK_DIR/config.tar.gz" -C "$RESTORE_DIR"
  echo "  Config restored to ${RESTORE_DIR}"
fi

echo ""
echo "=== Restore complete ==="
echo "Next steps:"
echo "  1. Verify application starts correctly"
echo "  2. Run integration tests"
echo "  3. Check data consistency"
echo "  4. Update DNS/load balancer if needed"
