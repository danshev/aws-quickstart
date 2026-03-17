#!/bin/bash
# act-as-account.sh
#
# Source this script to assume the configured cross-account role in the target
# AWS account and export temporary credentials into your current shell.
#
# Usage:
#   source ./scripts/act-as-account.sh <account-id>

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "❌ $1"
  return 1 2>/dev/null || exit 1
}

TARGET_ACCOUNT_ID="${1:-}"

if [ -z "$TARGET_ACCOUNT_ID" ]; then
  fail "Usage: source ./scripts/act-as-account.sh <account-id>"
fi

if [[ ! "$TARGET_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  fail "Invalid AWS account ID '$TARGET_ACCOUNT_ID'. Expected 12 digits."
fi

# Clear any previously-assumed-role credentials so the AWS CLI falls back
# to the base session established by `aws login`.
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN

CROSS_ACCOUNT_ROLE=$(
  cd "$PROJECT_ROOT" && npx ts-node -e "
    const { parseOrgConfig } = require('./scripts/org/parse-org-config');
    console.log(parseOrgConfig().crossAccountRoleName);
  "
)

echo "🔑 Assuming ${CROSS_ACCOUNT_ROLE} in account ${TARGET_ACCOUNT_ID}…"

credentials=$(aws sts assume-role \
  --role-arn "arn:aws:iam::${TARGET_ACCOUNT_ID}:role/${CROSS_ACCOUNT_ROLE}" \
  --role-session-name "CDKBootstrapSession" \
  --output json)

export AWS_ACCESS_KEY_ID=$(echo "$credentials" | jq -r ".Credentials.AccessKeyId")
export AWS_SECRET_ACCESS_KEY=$(echo "$credentials" | jq -r ".Credentials.SecretAccessKey")
export AWS_SESSION_TOKEN=$(echo "$credentials" | jq -r ".Credentials.SessionToken")

echo "✅ Assumed role in ${TARGET_ACCOUNT_ID}. Credentials exported to environment."
