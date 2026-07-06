#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/water-monitor}"
APP_USER="${APP_USER:-watermonitor}"
SERVICE_FILE="/etc/systemd/system/water-monitor.service"
WATCHDOG_SERVICE_FILE="/etc/systemd/system/water-monitor-watchdog.service"
DEFAULTS_FILE="/etc/default/water-monitor"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "*.sqlite*" \
  ./ "${APP_DIR}/"

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [[ ! -f "${DEFAULTS_FILE}" ]]; then
  install -m 0644 "${APP_DIR}/.env.example" "${DEFAULTS_FILE}"
fi

install -m 0644 "${APP_DIR}/systemd/water-monitor.service" "${SERVICE_FILE}"
install -m 0644 "${APP_DIR}/systemd/water-monitor-watchdog.service" "${WATCHDOG_SERVICE_FILE}"

cd "${APP_DIR}"
npm install --omit=dev

usermod -aG dialout "${APP_USER}" || true
systemctl daemon-reload
systemctl enable --now water-monitor
systemctl enable --now water-monitor-watchdog

echo "Installed water-monitor and its pump watchdog."
echo "Check logs with: journalctl -u water-monitor -f"
echo "Check watchdog logs with: journalctl -u water-monitor-watchdog -f"
