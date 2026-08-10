#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_root"

environment_file=${LAUNCHRAIL_ENV_FILE:-.env}
if [[ ! -f "$environment_file" ]]; then
  environment_file=.env.example
fi

set -a
# shellcheck disable=SC1090
source "$environment_file"
set +a

if [[ -z "${LAUNCHRAIL_SECRET_KEYRING:-}" ]]; then
  ephemeral_secret_key=$(
    node --input-type=module -e \
      'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"));'
  )
  LAUNCHRAIL_SECRET_KEYRING="1:${ephemeral_secret_key}"
  LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1
  export LAUNCHRAIL_SECRET_KEYRING LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION
  unset ephemeral_secret_key
fi

available_port() {
  node --input-type=module - <<'NODE'
import { createServer } from "node:net";

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.exit(1);
  }
  process.stdout.write(String(address.port));
  server.close();
});
NODE
}

API_HOST=127.0.0.1
API_PORT=$(available_port)
WORKER_HEALTH_HOST=127.0.0.1
WORKER_HEALTH_PORT=$(available_port)
WORKER_MODE=health-only
WEB_HOST=127.0.0.1
WEB_PORT=$(available_port)
export API_HOST API_PORT WORKER_HEALTH_HOST WORKER_HEALTH_PORT WORKER_MODE WEB_HOST WEB_PORT

log_directory=$(mktemp -d)
process_ids=()

cleanup() {
  for process_id in "${process_ids[@]}"; do
    kill "$process_id" 2>/dev/null || true
  done
  wait "${process_ids[@]}" 2>/dev/null || true
  rm -r "$log_directory"
}

show_logs() {
  for log_file in "$log_directory"/*.log; do
    if [[ -f "$log_file" ]]; then
      printf '\n%s\n' "==> ${log_file##*/} <=="
      tail -n 80 "$log_file"
    fi
  done
}

trap cleanup EXIT
trap show_logs ERR

pnpm --filter @launchrail/api start >"$log_directory/api.log" 2>&1 &
process_ids+=("$!")
pnpm --filter @launchrail/worker start >"$log_directory/worker.log" 2>&1 &
process_ids+=("$!")
NODE_ENV=production pnpm --filter @launchrail/web start >"$log_directory/web.log" 2>&1 &
process_ids+=("$!")

node scripts/wait-for-health.mjs "http://${API_HOST}:${API_PORT}/health" api
node scripts/wait-for-health.mjs \
  "http://${WORKER_HEALTH_HOST}:${WORKER_HEALTH_PORT}/health" worker
node scripts/wait-for-health.mjs "http://${WEB_HOST}:${WEB_PORT}/api/health" web
