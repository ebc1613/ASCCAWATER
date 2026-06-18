#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/water-monitor/water-monitor.sqlite}"
DAYS="${DAYS:-90}"

sqlite3 "${DB_PATH}" "DELETE FROM readings WHERE timestamp < datetime('now', '-${DAYS} days'); VACUUM;"
echo "Pruned readings older than ${DAYS} days from ${DB_PATH}."
