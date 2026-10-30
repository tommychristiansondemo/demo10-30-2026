#!/usr/bin/env bash
# Create (or reset) a user from the command line instead of the sign-up page:
#   ./scripts/create-user.sh dev alice Analyst      # prompts for the password (6+ characters)
set -euo pipefail
ENV="${1:?usage: $0 <dev|prod> <username> [Viewer|Analyst|Operator|Admin]}"
USERNAME="${2:?usage: $0 <dev|prod> <username> [Viewer|Analyst|Operator|Admin]}"
ROLE="${3:-Viewer}"
[[ "$ROLE" =~ ^(Viewer|Analyst|Operator|Admin)$ ]] || { echo "Role must be Viewer, Analyst, Operator or Admin"; exit 1; }
read -rsp "Password for $USERNAME (6+ characters): " PASSWORD; echo
OUT="$(dirname "$0")/../infra/cdk-outputs-$ENV.json"
POOL=$(node -e "console.log(require('$OUT')['GridSight-$ENV-Auth'].UserPoolId)")
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$USERNAME" \
  --user-attributes Name=custom:role,Value="$ROLE" --message-action SUPPRESS >/dev/null 2>&1 || true
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$USERNAME" --password "$PASSWORD" --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$USERNAME" --group-name "$ROLE"
echo "$USERNAME can now sign in with role $ROLE."
