#!/usr/bin/env bash
# One-command deploy:  ./scripts/deploy.sh dev [alarm-email]
set -euo pipefail

ENV="${1:-dev}"
ALARM_EMAIL="${2:-}"
REGION="${AWS_REGION:-us-east-1}"
ZONE="awsteach.com"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[[ "$ENV" == "dev" || "$ENV" == "prod" ]] || fail "usage: $0 <dev|prod> [alarm-email]"

say "Checking AWS credentials"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || fail "No AWS credentials"
echo "Account $ACCOUNT, region $REGION"
for probe in "cloudformation list-stacks --max-items 1" "route53 list-hosted-zones --max-items 1" "bedrock list-foundation-models --by-provider anthropic --max-results 1"; do
  aws $probe --region "$REGION" >/dev/null 2>&1 || fail "Missing permission for: aws $probe. GridSight needs an administrator-level deploy role."
done

say "Resolving Route 53 hosted zone for $ZONE"
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE" --query "HostedZones[?Name=='$ZONE.'].Id | [0]" --output text | sed 's#/hostedzone/##')
[[ "$ZONE_ID" != "None" && -n "$ZONE_ID" ]] || fail "Hosted zone $ZONE not found"
echo "Hosted zone $ZONE_ID"

say "Installing dependencies"
npm ci --no-audit --no-fund

say "Running tests"
npm test

say "Building web app"
npm run build -w web

say "Bootstrapping CDK (idempotent)"
(cd infra && npx cdk bootstrap "aws://$ACCOUNT/$REGION")

say "Deploying GridSight ($ENV)"
CTX=(-c "env=$ENV" -c "hostedZoneId=$ZONE_ID")
[[ -n "$ALARM_EMAIL" ]] && CTX+=(-c "alarmEmail=$ALARM_EMAIL")
APPROVAL=$([[ "$ENV" == "prod" ]] && echo "broadening" || echo "never")
npm run deploy -w infra -- --all "${CTX[@]}" --require-approval "$APPROVAL" --outputs-file "cdk-outputs-$ENV.json"

APP_URL=$(node -e "const o=require('./infra/cdk-outputs-$ENV.json');console.log(o['GridSight-$ENV-Edge'].AppUrl)")
say "Done: $APP_URL"
echo "Open $APP_URL and choose \"Create an account\" to register users with any role (username + 6-character password, no email)."
echo "Run ./scripts/smoke-test.sh $ENV to verify the API."
