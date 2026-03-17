#!/bin/bash
# assume_shared_services_role.sh
#
# Source this script to assume the Shared Services role in your current shell.
# Account name and role name are read from scripts/org/org-config.yaml so there
# are no hardcoded values.
#
# Usage:
#   source ./pre-bootstrap-scripts/assume_shared_services_role.sh

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Clear any previously-assumed-role credentials so the AWS CLI falls back
# to the SSO session established by `aws login`.
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN

# Extract values from org-config.yaml via a small ts-node one-liner.
SHARED_SVC_NAME=$(cd "$PROJECT_ROOT" && npx ts-node -e "
  const { parseOrgConfig, getSharedServicesAccount } = require('./scripts/org/parse-org-config');
  const config = parseOrgConfig();
  console.log(getSharedServicesAccount(config).name);
")

CROSS_ACCOUNT_ROLE=$(cd "$PROJECT_ROOT" && npx ts-node -e "
  const { parseOrgConfig } = require('./scripts/org/parse-org-config');
  console.log(parseOrgConfig().crossAccountRoleName);
")

export SHARED_SVC_ACCOUNT_ID=$(aws organizations list-accounts \
    --query "Accounts[?Name==\`${SHARED_SVC_NAME}\`].Id" \
    --output text)

if [ -z "$SHARED_SVC_ACCOUNT_ID" ] || [ "$SHARED_SVC_ACCOUNT_ID" = "None" ]; then
    echo "❌ Could not resolve account ID for '${SHARED_SVC_NAME}'."
    return 1 2>/dev/null || exit 1
fi

echo "🔑 Assuming ${CROSS_ACCOUNT_ROLE} in ${SHARED_SVC_NAME} (${SHARED_SVC_ACCOUNT_ID})…"

credentials=$(aws sts assume-role \
  --role-arn "arn:aws:iam::${SHARED_SVC_ACCOUNT_ID}:role/${CROSS_ACCOUNT_ROLE}" \
  --role-session-name "CDKBootstrapSession" \
  --output json)

export AWS_ACCESS_KEY_ID=$(echo "$credentials" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$credentials" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$credentials" | jq -r '.Credentials.SessionToken')

echo "✅ Assumed role. Credentials exported to environment."
