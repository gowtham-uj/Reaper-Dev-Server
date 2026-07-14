#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg git python3 python3-pip nodejs npm

. /etc/os-release

install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  case "${ID:-}" in
    ubuntu)
      DOCKER_REPO_BASE="https://download.docker.com/linux/ubuntu"
      ;;
    debian)
      DOCKER_REPO_BASE="https://download.docker.com/linux/debian"
      ;;
    *)
      echo "Unsupported distribution: ${ID:-unknown}" >&2
      exit 1
      ;;
  esac

  curl -fsSL "${DOCKER_REPO_BASE}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

case "${ID:-}" in
  ubuntu)
    DOCKER_REPO_BASE="https://download.docker.com/linux/ubuntu"
    ;;
  debian)
    DOCKER_REPO_BASE="https://download.docker.com/linux/debian"
    ;;
  *)
    echo "Unsupported distribution: ${ID:-unknown}" >&2
    exit 1
    ;;
esac

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] ${DOCKER_REPO_BASE} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

install -d /app/backend /app/frontend /app/https /app/workspace /app/monitoring /app/monitoring/logs /app/monitoring/tmp /app/theia-extensions /app/theia-data /app/theia-session-data /app/caddy-data /app/caddy-config /app/caddy-dynamic /app/pod-image /app/opencode/config /app/opencode/data /app/opencode/cache /app/terminal-home/root
install -d /root/codex-backups
RUNTIME_UID="${THEIA_RUNTIME_UID:-0}"
RUNTIME_GID="${THEIA_RUNTIME_GID:-0}"
chown -R "${RUNTIME_UID}:${RUNTIME_GID}" /app/workspace /app/monitoring /app/theia-data /app/opencode /app/terminal-home
echo "Bootstrap complete."
