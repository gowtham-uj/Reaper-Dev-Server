#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly IMAGE=${1:-reaper-pod:latest}
readonly CLAUDE_VERSION=2.1.212
readonly PACKAGE_ROOT=/usr/local/lib/node_modules

SOURCE_CONTAINER=
STAGING_DIR=$(mktemp -d)
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "${SOURCE_CONTAINER}" ]; then
    docker rm "${SOURCE_CONTAINER}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${STAGING_DIR}"
  exit "${status}"
}
trap cleanup EXIT

SOURCE_CONTAINER=$(docker create "${IMAGE}")
docker cp "${SOURCE_CONTAINER}:${PACKAGE_ROOT}/@anthropic-ai/claude-code" "${STAGING_DIR}/claude-code"

if [ "$(node -p 'require(process.argv[1]).version' "${STAGING_DIR}/claude-code/package.json")" != "${CLAUDE_VERSION}" ]; then
  echo "The ${IMAGE} Claude package is not the required version ${CLAUDE_VERSION}; refusing to provision pods." >&2
  exit 1
fi

mkdir "${STAGING_DIR}/@anthropic-ai"
mv "${STAGING_DIR}/claude-code" "${STAGING_DIR}/@anthropic-ai/claude-code"
cat >"${STAGING_DIR}/claude" <<'LAUNCHER'
#!/bin/sh
set -eu

: "${CLAUDE_CONFIG_DIR:=/work/.reaper/claude}"
export CLAUDE_CONFIG_DIR

if [ "$(id -u)" -eq 0 ]; then
  exec setpriv --reuid 65534 --regid 65534 --clear-groups \
    --inh-caps +dac_override,+fowner --ambient-caps +dac_override,+fowner \
    env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
    node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js \
    --dangerously-skip-permissions "$@"
fi

exec env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
  node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js \
  --dangerously-skip-permissions "$@"
LAUNCHER
chmod 0755 "${STAGING_DIR}/claude"

mapfile -t PROJECT_PODS < <(docker ps -a --filter label=reaper.project --format '{{.ID}}')
for pod in "${PROJECT_PODS[@]}"; do
  probe="${STAGING_DIR}/existing-${pod}"
  if docker cp "${pod}:/usr/local/bin/claude" "${probe}" >/dev/null 2>&1; then
    echo "Preserving existing Claude installation in project pod ${pod}."
    rm -rf -- "${probe}"
    continue
  fi

  docker cp "${STAGING_DIR}/@anthropic-ai" "${pod}:${PACKAGE_ROOT}/"
  docker cp "${STAGING_DIR}/claude" "${pod}:/usr/local/bin/claude"
  echo "Provisioned Claude ${CLAUDE_VERSION} in project pod ${pod}."
done

docker rm "${SOURCE_CONTAINER}" >/dev/null
SOURCE_CONTAINER=
rm -rf -- "${STAGING_DIR}"
trap - EXIT
