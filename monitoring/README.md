# Monitoring

Host-level runtime metrics are collected by the backend from mounted Linux procfs
and filesystem data.

- `logs/`: structured JSON application logs
- `alerts.sqlite`: alert and notification store
- `tmp/`: temporary runtime artifacts
- `cleanup-runtime.sh`: daily retention cleanup for logs and temp files older than 7 days
