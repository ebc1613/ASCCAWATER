#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/water-monitor/water-monitor.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/opt/water-monitor/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${BACKUP_DIR}"
sqlite3 "${DB_PATH}" ".backup '${BACKUP_DIR}/water-monitor-${STAMP}.sqlite'"
echo "${BACKUP_DIR}/water-monitor-${STAMP}.sqlite"
