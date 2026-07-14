#!/bin/sh
set -eu

RETENTION_DAYS="${CLEANUP_RETENTION_DAYS:-7}"
LOG_ROOT="/app/monitoring/logs"
TMP_ROOT="/app/monitoring/tmp"

mkdir -p "$LOG_ROOT" "$TMP_ROOT"

find "$LOG_ROOT" -type f -mtime "+$RETENTION_DAYS" -delete
find "$TMP_ROOT" -type f -mtime "+$RETENTION_DAYS" -delete
