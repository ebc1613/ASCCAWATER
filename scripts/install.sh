#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/water-monitor}"
APP_USER="${APP_USER:-watermonitor}"
SERVICE_FILE="/etc/systemd/system/water-monitor.service"
WATCHDOG_SERVICE_FILE="/etc/systemd/system/water-monitor-watchdog.service"
DEFAULTS_FILE="/etc/default/water-monitor"
NTFY_PORT="${NTFY_PORT:-8081}"
INSTALL_NTFY="${INSTALL_NTFY:-true}"
INSTALL_TAILSCALE="${INSTALL_TAILSCALE:-true}"

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

if [[ "${INSTALL_NTFY}" == "true" ]]; then
  echo
  echo "Installing ntfy (local push notification server)..."
  if ! command -v ntfy >/dev/null 2>&1; then
    apt-get update
    apt-get install -y apt-transport-https gnupg curl
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://archive.heckel.io/apt/pubkey.txt | gpg --dearmor -o /etc/apt/keyrings/archive.heckel.io.gpg
    echo "deb [signed-by=/etc/apt/keyrings/archive.heckel.io.gpg] https://archive.heckel.io/apt debian main" \
      > /etc/apt/sources.list.d/archive.heckel.io.list
    apt-get update
    apt-get install -y ntfy
  fi

  # Serve on all interfaces so LAN devices (phones, other monitors) can
  # reach it directly, not just this box's own loopback.
  sed -i "s|^listen-http:.*|listen-http: \":${NTFY_PORT}\"|" /etc/ntfy/server.yml
  if ! grep -q "^listen-http:" /etc/ntfy/server.yml; then
    echo "listen-http: \":${NTFY_PORT}\"" >> /etc/ntfy/server.yml
  fi

  systemctl enable --now ntfy
  echo "ntfy running on port ${NTFY_PORT}."
  echo "Set NTFY_SERVER_URL=http://127.0.0.1:${NTFY_PORT} (already the default in .env.example) and NTFY_TOPIC in ${DEFAULTS_FILE}, then enable notifications from /config.html."
fi

if [[ "${INSTALL_TAILSCALE}" == "true" ]]; then
  echo
  echo "Installing Tailscale..."
  if ! command -v tailscale >/dev/null 2>&1; then
    apt-get install -y curl lsb-release
    codename="$(lsb_release -cs)"
    mkdir -p /usr/share/keyrings /etc/apt/sources.list.d
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg" \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.tailscale-keyring.list" \
      -o /etc/apt/sources.list.d/tailscale.list
    apt-get update
    apt-get install -y tailscale
  fi
  systemctl enable --now tailscaled
  echo "Tailscale installed but NOT connected."
  echo "Run 'sudo tailscale up' yourself to authenticate this box (opens a login link) - that step needs a human, so the installer does not do it automatically."
fi
