#!/usr/bin/env ts-node
/**
 * setup-principal.ts — Create a non-root IAM principal in the management account.
 *
 * The management account root user cannot call sts:AssumeRole, which is required
 * by org:bootstrap and org:security. This script creates:
 *
 *   1. OrgSetupRole — IAM role with scoped org + cross-account permissions
 *   2. OrgSetupUser — Temporary IAM user that can assume the role
 *
 * After SSO is configured, run with --cleanup to remove the temporary user.
 *
 * Usage:
 *   npm run org:setup-principal
 *   npm run org:setup-principal -- --cleanup
 *   npm run org:setup-principal -- --setup-role-name CustomRoleName --management-profile custom-profile
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AwsExecOptions } from "./aws-helpers";
import {
  aws,
  awsJson,
  getCallerIdentity,
  getOrganizationManagementAccountId,
  isRootArn,
  log,
  logError,
  logStep,
  logSuccess,
  logWarn,
} from "./aws-helpers";
import { parseCliArgs } from "./cli";
import { parseOrgConfig } from "./parse-org-config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ROLE_NAME = "OrgSetupRole";
const DEFAULT_PROFILE_NAME = "org-setup";
const TEMP_USER_NAME = "OrgSetupUser";

// ---------------------------------------------------------------------------
// Policy document builders (exported for testing)
// ---------------------------------------------------------------------------

export function buildTrustPolicyDocument(
  managementAccountId: string,
  trustedPrincipalArns: string[],
): Record<string, unknown> {
  const principals = [
    `arn:aws:iam::${managementAccountId}:root`,
    ...trustedPrincipalArns,
  ];

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          AWS: principals.length === 1 ? principals[0] : principals,
        },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export function buildOrgSetupPermissionsPolicy(
  crossAccountRoleName: string,
): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OrganizationsReadWrite",
        Effect: "Allow",
        Action: [
          "organizations:DescribeOrganization",
          "organizations:ListAccounts",
          "organizations:ListAWSServiceAccessForOrganization",
          "organizations:EnableAWSServiceAccess",
          "organizations:ListDelegatedAdministrators",
          "organizations:RegisterDelegatedAdministrator",
          "organizations:DeregisterDelegatedAdministrator",
        ],
        Resource: "*",
      },
      {
        Sid: "CloudTrailAdmin",
        Effect: "Allow",
        Action: [
          "cloudtrail:RegisterOrganizationDelegatedAdmin",
          "cloudtrail:DeregisterOrganizationDelegatedAdmin",
          "iam:CreateServiceLinkedRole",
          "iam:GetRole",
        ],
        Resource: "*",
      },
      {
        Sid: "AccessAnalyzer",
        Effect: "Allow",
        Action: [
          "access-analyzer:ListAnalyzers",
          "access-analyzer:CreateAnalyzer",
        ],
        Resource: "*",
      },
      {
        Sid: "CrossAccountAssume",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: `arn:aws:iam::*:role/${crossAccountRoleName}`,
      },
    ],
  };
}

export function buildUserAssumeRolePolicy(
  roleArn: string,
): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: roleArn,
      },
    ],
  };
}

/**
 * Compare two IAM policy documents for semantic equality.
 * Normalizes by sorting statement arrays and comparing JSON.
 */
export function arePolicyDocumentsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return (
    JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b))
  );
}

function normalizePolicy(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  if (Array.isArray(copy.Statement)) {
    copy.Statement = (copy.Statement as Array<Record<string, unknown>>).sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Config file helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Insert or update managementProfile and managementSetupRoleName in org-config.yaml.
 * Returns the updated YAML content.
 */
export function upsertSetupConfigValues(
  yamlContent: string,
  profileName: string,
  roleName: string,
): string {
  let result = yamlContent;

  // managementProfile
  if (/^managementProfile:/m.test(result)) {
    result = result.replace(
      /^managementProfile:.*$/m,
      `managementProfile: ${profileName}`,
    );
  } else if (/^#\s*managementProfile:/m.test(result)) {
    result = result.replace(
      /^#\s*managementProfile:.*$/m,
      `managementProfile: ${profileName}`,
    );
  } else {
    // Insert after crossAccountRoleName
    result = result.replace(
      /^(crossAccountRoleName:.*$)/m,
      `$1\nmanagementProfile: ${profileName}`,
    );
  }

  // managementSetupRoleName
  if (/^managementSetupRoleName:/m.test(result)) {
    result = result.replace(
      /^managementSetupRoleName:.*$/m,
      `managementSetupRoleName: ${roleName}`,
    );
  } else if (/^#\s*managementSetupRoleName:/m.test(result)) {
    result = result.replace(
      /^#\s*managementSetupRoleName:.*$/m,
      `managementSetupRoleName: ${roleName}`,
    );
  } else {
    // Insert after managementProfile
    result = result.replace(
      /^(managementProfile:.*$)/m,
      `$1\nmanagementSetupRoleName: ${roleName}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Output rendering (exported for testing)
// ---------------------------------------------------------------------------

export function renderAwsCredentialsSnippet(
  profileName: string,
  accessKeyId: string,
  secretAccessKey: string,
): string {
  return `[${profileName}-user]
aws_access_key_id = ${accessKeyId}
aws_secret_access_key = ${secretAccessKey}`;
}

export function renderAwsProfileSnippet(
  profileName: string,
  roleArn: string,
  region: string,
): string {
  return `[profile ${profileName}]
role_arn = ${roleArn}
source_profile = ${profileName}-user
region = ${region}`;
}

// ---------------------------------------------------------------------------
// IAM operations
// ---------------------------------------------------------------------------

function roleExists(roleName: string, opts: AwsExecOptions = {}): boolean {
  try {
    aws(`iam get-role --role-name ${roleName}`, { ...opts, silent: true });
    return true;
  } catch {
    return false;
  }
}

function userExists(userName: string, opts: AwsExecOptions = {}): boolean {
  try {
    aws(`iam get-user --user-name ${userName}`, { ...opts, silent: true });
    return true;
  } catch {
    return false;
  }
}

function createOrUpdateRole(
  roleName: string,
  trustPolicy: Record<string, unknown>,
  permissionsPolicy: Record<string, unknown>,
  opts: AwsExecOptions = {},
): void {
  const trustJson = JSON.stringify(trustPolicy);
  const permJson = JSON.stringify(permissionsPolicy);

  if (roleExists(roleName, opts)) {
    logStep(
      `Role ${roleName} already exists — updating trust and permissions…`,
    );
    aws(
      `iam update-assume-role-policy --role-name ${roleName} --policy-document '${trustJson}'`,
      opts,
    );
    aws(
      `iam put-role-policy --role-name ${roleName} --policy-name OrgSetupPermissions --policy-document '${permJson}'`,
      opts,
    );
    logSuccess(`Role ${roleName} updated.`);
  } else {
    logStep(`Creating role ${roleName}…`);
    aws(
      `iam create-role --role-name ${roleName} --assume-role-policy-document '${trustJson}' --description "Management account principal for org bootstrap scripts"`,
      opts,
    );
    aws(
      `iam put-role-policy --role-name ${roleName} --policy-name OrgSetupPermissions --policy-document '${permJson}'`,
      opts,
    );
    logSuccess(`Role ${roleName} created.`);
  }
}

interface AccessKeyResult {
  AccessKey: {
    AccessKeyId: string;
    SecretAccessKey: string;
  };
}

interface ListAccessKeysResult {
  AccessKeyMetadata: Array<{ AccessKeyId: string }>;
}

function createOrRotateAccessKey(
  userName: string,
  opts: AwsExecOptions = {},
): { accessKeyId: string; secretAccessKey: string } {
  // Delete existing keys first
  const existingKeys = awsJson<ListAccessKeysResult>(
    `iam list-access-keys --user-name ${userName}`,
    opts,
  );
  for (const key of existingKeys.AccessKeyMetadata) {
    logStep(`Deleting existing access key ${key.AccessKeyId}…`);
    aws(
      `iam delete-access-key --user-name ${userName} --access-key-id ${key.AccessKeyId}`,
      opts,
    );
  }

  const result = awsJson<AccessKeyResult>(
    `iam create-access-key --user-name ${userName}`,
    opts,
  );

  return {
    accessKeyId: result.AccessKey.AccessKeyId,
    secretAccessKey: result.AccessKey.SecretAccessKey,
  };
}

function createOrUpdateUser(
  userName: string,
  assumeRolePolicy: Record<string, unknown>,
  opts: AwsExecOptions = {},
): { accessKeyId: string; secretAccessKey: string } {
  const policyJson = JSON.stringify(assumeRolePolicy);

  if (userExists(userName, opts)) {
    logStep(
      `User ${userName} already exists — updating policy and rotating key…`,
    );
    aws(
      `iam put-user-policy --user-name ${userName} --policy-name AssumeOrgSetupRole --policy-document '${policyJson}'`,
      opts,
    );
  } else {
    logStep(`Creating user ${userName}…`);
    aws(`iam create-user --user-name ${userName}`, opts);
    aws(
      `iam put-user-policy --user-name ${userName} --policy-name AssumeOrgSetupRole --policy-document '${policyJson}'`,
      opts,
    );
    logSuccess(`User ${userName} created.`);
  }

  return createOrRotateAccessKey(userName, opts);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanupUser(
  userName: string,
  roleName: string,
  managementAccountId: string,
  opts: AwsExecOptions = {},
): void {
  if (!userExists(userName, opts)) {
    logWarn(`User ${userName} does not exist — nothing to clean up.`);
    return;
  }

  // Delete access keys
  const existingKeys = awsJson<ListAccessKeysResult>(
    `iam list-access-keys --user-name ${userName}`,
    opts,
  );
  for (const key of existingKeys.AccessKeyMetadata) {
    logStep(`Deleting access key ${key.AccessKeyId}…`);
    aws(
      `iam delete-access-key --user-name ${userName} --access-key-id ${key.AccessKeyId}`,
      opts,
    );
  }

  // Delete inline policy
  try {
    aws(
      `iam delete-user-policy --user-name ${userName} --policy-name AssumeOrgSetupRole`,
      opts,
    );
    logStep("Deleted inline policy from user.");
  } catch {
    // Policy may not exist
  }

  // Delete user
  aws(`iam delete-user --user-name ${userName}`, opts);
  logSuccess(`User ${userName} deleted.`);

  // Update role trust policy to remove user ARN
  if (roleExists(roleName, opts)) {
    const userArn = `arn:aws:iam::${managementAccountId}:user/${userName}`;
    try {
      const roleData = awsJson<{
        Role: { AssumeRolePolicyDocument: string };
      }>(`iam get-role --role-name ${roleName}`, opts);

      const trustDoc = JSON.parse(
        decodeURIComponent(roleData.Role.AssumeRolePolicyDocument),
      ) as Record<string, unknown>;

      const statements = trustDoc.Statement as Array<Record<string, unknown>>;
      for (const stmt of statements) {
        const principal = stmt.Principal as Record<string, unknown>;
        if (principal.AWS) {
          if (Array.isArray(principal.AWS)) {
            principal.AWS = (principal.AWS as string[]).filter(
              (arn) => arn !== userArn,
            );
            if ((principal.AWS as string[]).length === 1) {
              principal.AWS = (principal.AWS as string[])[0];
            }
          }
        }
      }

      aws(
        `iam update-assume-role-policy --role-name ${roleName} --policy-document '${JSON.stringify(trustDoc)}'`,
        opts,
      );
      logSuccess(`Removed ${userName} from ${roleName} trust policy.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Could not update trust policy: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = parseOrgConfig(args.config);

  const roleName =
    args.setupRoleName ?? config.managementSetupRoleName ?? DEFAULT_ROLE_NAME;
  const profileName =
    args.managementProfile ?? config.managementProfile ?? DEFAULT_PROFILE_NAME;
  const callerOpts: AwsExecOptions = args.callerProfile
    ? { profile: args.callerProfile }
    : {};

  // Detect caller identity
  logStep("Checking caller identity…");
  const identity = getCallerIdentity(callerOpts);
  log("🔍", `Caller: ${identity.Arn}`);

  if (isRootArn(identity.Arn)) {
    logWarn(
      "Running as root user. This is expected for first-time setup, " +
        "but the root user cannot assume roles. After setup, switch to the new profile.",
    );
  }

  // Verify management account context
  logStep("Verifying management account context…");
  const managementAccountId = getOrganizationManagementAccountId(callerOpts);
  if (identity.Account !== managementAccountId) {
    throw new Error(
      `This script must run in the management account (${managementAccountId}), ` +
        `but the current caller is in account ${identity.Account}.`,
    );
  }
  logSuccess(`Operating in management account ${managementAccountId}.`);

  // Verify ALL features mode
  logStep("Verifying organization is in ALL features mode…");
  const org = awsJson<{
    Organization: { FeatureSet: string };
  }>("organizations describe-organization", callerOpts);
  if (org.Organization.FeatureSet !== "ALL") {
    throw new Error(
      `Organization must be in ALL features mode (currently "${org.Organization.FeatureSet}").`,
    );
  }
  logSuccess("Organization is in ALL features mode.");

  // Handle cleanup mode
  if (args.cleanup) {
    log("🧹", `Cleaning up temporary user ${TEMP_USER_NAME}…`);
    cleanupUser(TEMP_USER_NAME, roleName, managementAccountId, callerOpts);
    logSuccess("Cleanup complete. The role remains for SSO-based access.");
    return;
  }

  // Build trust policy — account root is sufficient; any IAM principal in the
  // account can assume the role as long as it has sts:AssumeRole permission.
  // No need to list the user ARN explicitly (avoids IAM eventual-consistency errors).
  const extraTrustArns: string[] = [];
  if (args.trustedPrincipalArn) {
    extraTrustArns.push(args.trustedPrincipalArn);
  }

  const trustPolicy = buildTrustPolicyDocument(
    managementAccountId,
    extraTrustArns,
  );
  const permissionsPolicy = buildOrgSetupPermissionsPolicy(
    config.crossAccountRoleName,
  );

  // Create/update role
  log("🔐", `Setting up IAM role: ${roleName}`);
  createOrUpdateRole(roleName, trustPolicy, permissionsPolicy, callerOpts);

  // Create/update user + access key
  log("👤", `Setting up temporary IAM user: ${TEMP_USER_NAME}`);
  const roleArn = `arn:aws:iam::${managementAccountId}:role/${roleName}`;
  const userPolicy = buildUserAssumeRolePolicy(roleArn);
  const { accessKeyId, secretAccessKey } = createOrUpdateUser(
    TEMP_USER_NAME,
    userPolicy,
    callerOpts,
  );

  // Write config if requested or by default
  if (args.writeConfig !== false) {
    const configPath =
      args.config ?? path.resolve(__dirname, "org-config.yaml");
    const yamlContent = fs.readFileSync(configPath, "utf-8");
    const updated = upsertSetupConfigValues(yamlContent, profileName, roleName);
    fs.writeFileSync(configPath, updated, "utf-8");
    logSuccess(
      `Updated ${configPath} with managementProfile and managementSetupRoleName.`,
    );
  }

  // Print instructions
  const credSnippet = renderAwsCredentialsSnippet(
    profileName,
    accessKeyId,
    secretAccessKey,
  );
  const profileSnippet = renderAwsProfileSnippet(
    profileName,
    roleArn,
    config.region,
  );

  console.log(`
${"=".repeat(55)}
  SETUP COMPLETE — Follow these steps to continue
${"=".repeat(55)}

Step 1: Add credentials to ~/.aws/credentials
${"─".repeat(47)}
${credSnippet}

Step 2: Add profile to ~/.aws/config
${"─".repeat(37)}
${profileSnippet}

Step 3: Verify the profile works
${"─".repeat(32)}
aws sts get-caller-identity --profile ${profileName}

You should see the ${roleName} ARN (not root).

Step 4: Resume org bootstrap
${"─".repeat(28)}
npm run org:bootstrap
npm run org:security

These scripts auto-detect the profile from org-config.yaml.

Step 5: After SSO is configured, clean up the temp user
${"─".repeat(55)}
npm run org:setup-principal -- --cleanup
`);
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
