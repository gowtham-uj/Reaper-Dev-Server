#!/usr/bin/env bash
# Ensure every project pod has a working `claude` on PATH.
#
# Pods are durable: deploys never recreate them, so a pod can outlive several
# changes to where npm puts the Claude package. This script therefore checks
# what actually works inside each pod instead of assuming a layout, and repairs
# what does not. It never replaces a healthy installation.
#
# History that this guards against: an older revision wrote a launcher shim at
# /usr/local/bin/claude with the package path hard-coded to
# /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js. Later images
# install to /usr/lib/node_modules with a native bin/claude.exe entry, so the
# shim resolved to nothing -- and because it still existed, the old
# "preserve any existing installation" check skipped the pod forever. Every
# affected pod failed with MODULE_NOT_FOUND on every `claude` invocation.
set -euo pipefail
umask 077

readonly IMAGE=${1:-reaper-pod:latest}
# Must track the pod image pin. 2.1.238 and later reject the cloud proxy's
# custom model ids with `[claude-code:unrecognized_model]`.
readonly CLAUDE_VERSION=2.1.223
readonly PACKAGE_ROOTS=(/usr/local/lib/node_modules /usr/lib/node_modules)
readonly SHIM=/usr/local/bin/claude

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

# Probe: does `claude` run at all in this pod?
claude_works() {
  docker exec "$1" sh -c 'timeout 60 claude --version >/dev/null 2>&1'
}

# Probe: is the package installed anywhere the launcher can find it?
package_present() {
  docker exec "$1" sh -c '
    for root in /usr/local/lib/node_modules /usr/lib/node_modules; do
      pkg="$root/@anthropic-ai/claude-code"
      [ -x "$pkg/bin/claude.exe" ] && exit 0
      [ -f "$pkg/cli.js" ] && exit 0
    done
    exit 1'
}

SOURCE_PACKAGE_ROOT=
for candidate in "${PACKAGE_ROOTS[@]}"; do
  rm -rf -- "${STAGING_DIR}/claude-code"
  if docker cp "${SOURCE_CONTAINER:=$(docker create "${IMAGE}")}:${candidate}/@anthropic-ai/claude-code" \
    "${STAGING_DIR}/claude-code" 2>/dev/null; then
    SOURCE_PACKAGE_ROOT=${candidate}
    break
  fi
done
if [ -z "${SOURCE_PACKAGE_ROOT}" ]; then
  echo "The ${IMAGE} image does not contain the Claude package; refusing to provision pods." >&2
  exit 1
fi

if [ "$(node -p 'require(process.argv[1]).version' "${STAGING_DIR}/claude-code/package.json")" != "${CLAUDE_VERSION}" ]; then
  echo "The ${IMAGE} Claude package is not the required version ${CLAUDE_VERSION}; refusing to provision pods." >&2
  exit 1
fi

mkdir "${STAGING_DIR}/@anthropic-ai"
mv "${STAGING_DIR}/claude-code" "${STAGING_DIR}/@anthropic-ai/claude-code"
# `umask 077` above would otherwise copy the tree in mode 0700, which the
# unprivileged launcher user cannot traverse.
chmod -R a+rX "${STAGING_DIR}/@anthropic-ai"

# The launcher resolves the package at run time so a future change to npm's
# global prefix, or to the package entry point, cannot strand it again.
cat >"${STAGING_DIR}/claude" <<'LAUNCHER'
#!/bin/sh
set -eu

: "${CLAUDE_CONFIG_DIR:=/work/.reaper/claude}"
export CLAUDE_CONFIG_DIR

entry_js=
entry_bin=
for root in /usr/local/lib/node_modules /usr/lib/node_modules; do
  pkg="$root/@anthropic-ai/claude-code"
  if [ -x "$pkg/bin/claude.exe" ]; then entry_bin="$pkg/bin/claude.exe"; break; fi
  if [ -f "$pkg/cli.js" ]; then entry_js="$pkg/cli.js"; break; fi
done
if [ -z "$entry_js" ] && [ -z "$entry_bin" ]; then
  echo "claude: no Claude Code installation found in /usr/local/lib/node_modules or /usr/lib/node_modules" >&2
  exit 127
fi

launch() {
  if [ "$(id -u)" -eq 0 ]; then
    exec setpriv --reuid 65534 --regid 65534 --clear-groups \
      --inh-caps +dac_override,+fowner --ambient-caps +dac_override,+fowner \
      env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
      "$@"
  fi
  exec env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' "$@"
}

if [ -n "$entry_bin" ]; then
  launch "$entry_bin" --dangerously-skip-permissions "$@"
fi
launch node "$entry_js" --dangerously-skip-permissions "$@"
LAUNCHER
chmod 0755 "${STAGING_DIR}/claude"

failed=()
mapfile -t PROJECT_PODS < <(docker ps -a --filter label=reaper.project --format '{{.ID}}')
for pod in "${PROJECT_PODS[@]}"; do
  if ! docker inspect -f '{{.State.Running}}' "${pod}" 2>/dev/null | grep -q true; then
    echo "Skipping stopped project pod ${pod}."
    continue
  fi

  if claude_works "${pod}"; then
    echo "Claude already healthy in project pod ${pod}."
    continue
  fi

  # A stale shim shadows the package launcher earlier on PATH. When the package
  # itself is present, dropping the shim restores the pod to the same state as
  # a freshly created one.
  if package_present "${pod}" && docker exec "${pod}" test -f "${SHIM}"; then
    docker exec "${pod}" rm -f "${SHIM}"
    if claude_works "${pod}"; then
      echo "Removed a stale Claude launcher shim in project pod ${pod}."
      continue
    fi
  fi

  if ! package_present "${pod}"; then
    docker cp "${STAGING_DIR}/@anthropic-ai" "${pod}:${PACKAGE_ROOTS[0]}/"
    docker exec "${pod}" chmod -R a+rX "${PACKAGE_ROOTS[0]}"
  fi
  docker cp "${STAGING_DIR}/claude" "${pod}:${SHIM}"
  docker exec "${pod}" chmod 0755 "${SHIM}"

  if claude_works "${pod}"; then
    echo "Provisioned Claude ${CLAUDE_VERSION} in project pod ${pod}."
  else
    echo "Claude is still not runnable in project pod ${pod}." >&2
    failed+=("${pod}")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Claude provisioning failed for: ${failed[*]}" >&2
  exit 1
fi

docker rm "${SOURCE_CONTAINER}" >/dev/null
SOURCE_CONTAINER=
rm -rf -- "${STAGING_DIR}"
trap - EXIT
