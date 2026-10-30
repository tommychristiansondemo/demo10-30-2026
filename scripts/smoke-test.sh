#!/usr/bin/env bash
# Post-deploy verification:  ./scripts/smoke-test.sh dev
# Registers two throwaway users (Viewer and Admin) through the same self sign-up flow students use,
# with random usernames and passwords, exercises the API, then deletes them.
set -uo pipefail
ENV="${1:-dev}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/infra/cdk-outputs-$ENV.json"
[[ -f "$OUT" ]] || { echo "Missing $OUT (run ./scripts/deploy.sh first)"; exit 1; }
API=$(node -e "console.log(require('$OUT')['GridSight-$ENV-Edge'].ApiUrl)")
CLIENT_ID=$(node -e "console.log(require('$OUT')['GridSight-$ENV-Auth'].CliClientId)")
FAILED=0

ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
# expect_json <name> <jq-test> <curl args...>
expect_json() { local name="$1" test="$2"; shift 2; if curl -fsS --max-time 40 "$@" | jq -e "$test" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
# expect_status <name> <code> <curl args...>
expect_status() { local name="$1" code="$2"; shift 2; [[ $(curl -s -o /dev/null -w '%{http_code}' "$@") == "$code" ]] && ok "$name" || bad "$name"; }

expect_json "health endpoint (public)" '.status == "ok"' "$API/v1/health"
expect_status "unauthenticated request rejected" 401 "$API/v1/grid/current"

POOL_ID=$(node -e "console.log(require('$OUT')['GridSight-$ENV-Auth'].UserPoolId)")
RUN_ID="smoke-$(date +%s)-$RANDOM"
# register runs in a subshell, so list the usernames it will create up front for cleanup.
CREATED=("$RUN_ID-viewer" "$RUN_ID-admin")
cleanup() { for u in "${CREATED[@]}"; do aws cognito-idp admin-delete-user --region us-east-1 --user-pool-id "$POOL_ID" --username "$u" >/dev/null 2>&1; done; }
trap cleanup EXIT

# register <role> → prints an access token for a new user with that role
register() {
  local user="$RUN_ID-$(tr '[:upper:]' '[:lower:]' <<<"$1")" pass; pass=$(openssl rand -hex 8)
  aws cognito-idp sign-up --region us-east-1 --client-id "$CLIENT_ID" --username "$user" --password "$pass" \
    --user-attributes Name=custom:role,Value="$1" >/dev/null || return 1
  aws cognito-idp initiate-auth --region us-east-1 --client-id "$CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$user,PASSWORD=$pass" --query AuthenticationResult.AccessToken --output text
}

VIEWER_TOKEN=$(register Viewer) && ok "self sign-up as Viewer (auto-confirmed)" || { bad "self sign-up as Viewer"; exit 1; }
TOKEN=$(register Admin) && ok "self sign-up as Admin (auto-confirmed)" || { bad "self sign-up as Admin"; exit 1; }
expect_json "Viewer token carries Viewer role" '.user.role == "Viewer"' -H "Authorization: Bearer $VIEWER_TOKEN" "$API/v1/me"
expect_json "Admin token carries Admin role"   '.user.role == "Admin"'  -H "Authorization: Bearer $TOKEN" "$API/v1/me"
expect_status "Viewer blocked from AI assistant" 403 -H "Authorization: Bearer $VIEWER_TOKEN" -H 'content-type: application/json' -d '{"message":"hi"}' "$API/v1/ai/ask"
expect_json "Admin can list users" '.users | length >= 2' -H "Authorization: Bearer $TOKEN" "$API/v1/admin/users"
AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H 'content-type: application/json')

expect_json "current grid interval"   '.load_mw > 0'                 "${AUTH[@]}" "$API/v1/grid/current"
expect_json "24h series"              '.points | length > 100'       "${AUTH[@]}" "$API/v1/grid/series"
expect_json "alert feed"              '.alerts | type == "array"'    "${AUTH[@]}" "$API/v1/alerts?status=RESOLVED"
expect_json "load forecast"           '.points | length == 24'       "${AUTH[@]}" "$API/v1/forecast/load?hours=24"
expect_json "athena SQL"              '.rows[0].n > 0'               "${AUTH[@]}" "${JSON[@]}" -d "{\"sql\":\"SELECT count(*) AS n FROM grid_interval WHERE dt = '$(date -u +%F)'\"}" "$API/v1/query/sql"
expect_status "SQL guard rejects DDL" 400                            "${AUTH[@]}" "${JSON[@]}" -d '{"sql":"DROP TABLE grid_interval"}' "$API/v1/query/sql"
expect_json "knowledge base search"   '.passages | length > 0'       "${AUTH[@]}" "$API/v1/kb/search?q=physical%20responsive%20capability"
expect_json "AI assistant (Bedrock)"  '.answer | length > 0'         "${AUTH[@]}" "${JSON[@]}" -d '{"message":"What is the current system load? One sentence."}' "$API/v1/ai/ask"

exit $FAILED
