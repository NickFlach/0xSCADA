#!/usr/bin/env bash
# 0xSCADA Backup Script
# Issue #53 — Disaster Recovery & Backup Strategy
#
# Usage:
#   ./scripts/backup.sh [full|database|config]
#
# Environment variables:
#   BACKUP_DIR       — Backup destination (default: /backups)
#   DATABASE_URL     — PostgreSQL connection string
#   ENCRYPTION_KEY   — AES-256 encryption key (required)
#   S3_BUCKET        — Optional S3 bucket for remote copy

set -euo pipefail

BACKUP_TYPE="${1:-full}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_NAME="0xscada-${BACKUP_TYPE}-${TIMESTAMP}"
WORK_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

echo "=== 0xSCADA Backup: ${BACKUP_TYPE} ==="
echo "Timestamp: ${TIMESTAMP}"
echo "Destination: ${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Database backup
# ---------------------------------------------------------------------------
backup_database() {
  echo "[1/3] Backing up database..."
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "  WARNING: DATABASE_URL not set, skipping database backup"
    return
  fi
  pg_dump "$DATABASE_URL" --format=custom --compress=9 \
    -f "$WORK_DIR/database.dump"
  echo "  Database backup complete"
}

# ---------------------------------------------------------------------------
# Config backup
# ---------------------------------------------------------------------------
backup_config() {
  echo "[2/3] Backing up configuration..."
  tar czf "$WORK_DIR/config.tar.gz" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    -C "$(dirname "$0")/.." \
    .env* \
    docker-compose*.yml \
    server/security/ \
    2>/dev/null || echo "  Some config files not found (ok)"
  echo "  Config backup complete"
}

# ---------------------------------------------------------------------------
# Create archive
# ---------------------------------------------------------------------------
create_archive() {
  echo "[3/3] Creating encrypted archive..."
  ARCHIVE="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
  tar czf "$ARCHIVE" -C "$WORK_DIR" .

  if [ -n "${ENCRYPTION_KEY:-}" ]; then
    openssl enc -aes-256-cbc -salt -pbkdf2 \
      -in "$ARCHIVE" \
      -out "${ARCHIVE}.enc" \
      -pass "pass:${ENCRYPTION_KEY}"
    rm "$ARCHIVE"
    ARCHIVE="${ARCHIVE}.enc"
    echo "  Archive encrypted"
  else
    echo "  WARNING: ENCRYPTION_KEY not set, archive is unencrypted"
  fi

  echo "  Archive: ${ARCHIVE}"
  echo "  Size: $(du -h "$ARCHIVE" | cut -f1)"
}

# ---------------------------------------------------------------------------
# Remote copy
# ---------------------------------------------------------------------------
upload_remote() {
  if [ -n "${S3_BUCKET:-}" ]; then
    echo "Uploading to S3: ${S3_BUCKET}..."
    aws s3 cp "$ARCHIVE" "s3://${S3_BUCKET}/backups/${BACKUP_NAME}.tar.gz.enc"
    echo "  Upload complete"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "$BACKUP_TYPE" in
  full)
    backup_database
    backup_config
    ;;
  database)
    backup_database
    ;;
  config)
    backup_config
    ;;
  *)
    echo "Usage: $0 [full|database|config]"
    exit 1
    ;;
esac

create_archive
upload_remote

echo ""
echo "=== Backup complete: ${BACKUP_NAME} ==="
