#!/usr/bin/env bash
set -euo pipefail
umask 077

cd /app

BACKUP_DIR=/root/codex-backups
mkdir -p "${BACKUP_DIR}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created /app/.env from template. Set the required secrets, then run deploy again." >&2
fi

# Fail before backup, image build, or service changes when required secrets are
# missing, blank, or the Compose configuration is invalid.
docker compose config --quiet >/dev/null


STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="${BACKUP_DIR}/app-backup-${STAMP}.tar.gz"
BACKUP_EXCLUDES=(
  app/.codex-backups
  app/.codex-staging
  app/backups
  'app/workspace-backup-*'
  app/workspace
  app/opencode
  app/terminal-home
  app/caddy-data
  app/caddy-config
  app/caddy-dynamic
  app/theia-data
  app/theia-session-data
  app/postgres-data
  app/monitoring/tmp
  app/monitoring/logs
  'app/monitoring/alerts.sqlite*'
  app/backend/.reaper-local
  app/.reaper-local
  app/backend-state/archive
  'app/backend-state/audit.log*'
  app/tmp
  app/logs
  app/node_modules
  'app/*/node_modules'
  app/build
  'app/*/build'
)
tar -C / --create --gzip --file="${ARCHIVE}" \
  --anchored --wildcards --wildcards-match-slash \
  "${BACKUP_EXCLUDES[@]/#/--exclude=}" \
  app

MEMBER_LIST=$(mktemp)
trap 'rm -f -- "${MEMBER_LIST}"' EXIT
if ! tar --list --gzip --file="${ARCHIVE}" --quoting-style=escape >"${MEMBER_LIST}"; then
  echo "Could not validate the application backup; refusing to deploy." >&2
  rm -f -- "${ARCHIVE}"
  exit 1
fi

FORBIDDEN_BACKUP_MEMBER=
while IFS= read -r MEMBER; do
  case "${MEMBER}" in
    app/.codex-backups|app/.codex-backups/*|\
    app/.codex-staging|app/.codex-staging/*|\
    app/backups|app/backups/*|\
    app/workspace-backup-*|\
    app/workspace|app/workspace/*|\
    app/opencode|app/opencode/*|\
    app/terminal-home|app/terminal-home/*|\
    app/caddy-data|app/caddy-data/*|\
    app/caddy-config|app/caddy-config/*|\
    app/caddy-dynamic|app/caddy-dynamic/*|\
    app/theia-data|app/theia-data/*|\
    app/theia-session-data|app/theia-session-data/*|\
    app/postgres-data|app/postgres-data/*|\
    app/monitoring/tmp|app/monitoring/tmp/*|\
    app/monitoring/logs|app/monitoring/logs/*|\
    app/monitoring/alerts.sqlite*|\
    app/backend/.reaper-local|app/backend/.reaper-local/*|\
    app/.reaper-local|app/.reaper-local/*|\
    app/backend-state/archive|app/backend-state/archive/*|\
    app/backend-state/audit.log*|\
    app/tmp|app/tmp/*|\
    app/logs|app/logs/*|\
    app/node_modules|app/node_modules/*|app/*/node_modules|app/*/node_modules/*|\
    app/build|app/build/*|app/*/build|app/*/build/*)
      FORBIDDEN_BACKUP_MEMBER=${MEMBER}
      break
      ;;
  esac
done <"${MEMBER_LIST}"
rm -f -- "${MEMBER_LIST}"
trap - EXIT

if [ -n "${FORBIDDEN_BACKUP_MEMBER}" ]; then
  echo "Backup contains a forbidden runtime or generated path; refusing to deploy." >&2
  rm -f -- "${ARCHIVE}"
  exit 1
fi


mapfile -t OLD_BACKUPS < <(ls -1t "${BACKUP_DIR}"/app-backup-*.tar.gz 2>/dev/null | tail -n +3 || true)
if [ "${#OLD_BACKUPS[@]}" -gt 0 ]; then
  rm -f -- "${OLD_BACKUPS[@]}"
fi
mapfile -t OLD_POD_BACKUPS < <(ls -1t "${BACKUP_DIR}"/project-pods-*.tar.gz 2>/dev/null | tail -n +3 || true)
if [ "${#OLD_POD_BACKUPS[@]}" -gt 0 ]; then
  rm -f -- "${OLD_POD_BACKUPS[@]}"
fi
STAGING_ROOT=/app/.codex-staging
FRONTEND_STAGE="${STAGING_ROOT}/frontend-dist-${STAMP}"
FRONTEND_PREVIOUS="${STAGING_ROOT}/frontend-dist-previous-${STAMP}"
mkdir -p "${STAGING_ROOT}"
rm -rf -- "${FRONTEND_STAGE}" "${FRONTEND_PREVIOUS}"
npm ci --prefix frontend-v2
npm run build --prefix frontend-v2 -- --outDir "${FRONTEND_STAGE}" --emptyOutDir
if [ ! -f "${FRONTEND_STAGE}/index.html" ]; then
  echo "Frontend staging build did not produce index.html; refusing to deploy." >&2
  rm -rf -- "${FRONTEND_STAGE}"
  exit 1
fi

RUNTIME_UID="${THEIA_RUNTIME_UID:-0}"
RUNTIME_GID="${THEIA_RUNTIME_GID:-0}"

mkdir -p /app/https /app/workspace /app/monitoring /app/monitoring/logs /app/monitoring/tmp /app/theia-data /app/theia-session-data /app/caddy-data /app/caddy-config /app/caddy-dynamic /app/opencode/config /app/opencode/data /app/opencode/cache /app/terminal-home/root
mkdir -p /app/global-env
if [ ! -f /app/global-env/global-env.json ]; then
  if [ -f /app/global-env.json ]; then
    install -m 600 /app/global-env.json /app/global-env/global-env.json
  else
    printf '{}\n' > /app/global-env/global-env.json
    chmod 600 /app/global-env/global-env.json
  fi
fi
chown -R "${RUNTIME_UID}:${RUNTIME_GID}" /app/workspace /app/monitoring /app/theia-data /app/opencode /app/terminal-home

docker build -t reaper-pod:latest ./pod-image

# Project pods are durable runtime state. Deploy must never enumerate, stop,
# remove, or recreate any reaper-pod-* container.
if ! docker compose up -d --build --remove-orphans --wait --wait-timeout 180; then
  rm -rf -- "${FRONTEND_STAGE}"
  echo "Reaper services did not become healthy; the pre-cutover backup is retained at ${ARCHIVE}." >&2
  exit 1
fi

HAD_PREVIOUS_FRONTEND=false
if [ -e /app/frontend-v2/dist ]; then
  mv /app/frontend-v2/dist "${FRONTEND_PREVIOUS}"
  HAD_PREVIOUS_FRONTEND=true
fi
if ! mv "${FRONTEND_STAGE}" /app/frontend-v2/dist; then
  if ${HAD_PREVIOUS_FRONTEND}; then mv "${FRONTEND_PREVIOUS}" /app/frontend-v2/dist; fi
  echo "Could not atomically promote the staged frontend; the previous release remains live." >&2
  exit 1
fi

if ! docker compose up -d --force-recreate --no-deps --wait --wait-timeout 60 caddy \
  || ! docker exec reaper-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null; then
  rm -rf -- /app/frontend-v2/dist
  if ${HAD_PREVIOUS_FRONTEND}; then
    mv "${FRONTEND_PREVIOUS}" /app/frontend-v2/dist
  else
    mkdir -p /app/frontend-v2/dist
  fi
  docker compose up -d --force-recreate --no-deps caddy >/dev/null 2>&1 || true
  docker exec reaper-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  echo "Caddy/frontend activation failed; the previous frontend was restored and the backup is retained at ${ARCHIVE}." >&2
  exit 1
fi
rm -rf -- "${FRONTEND_PREVIOUS}"
docker compose ps
