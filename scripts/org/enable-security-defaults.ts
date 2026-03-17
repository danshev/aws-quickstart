#!/usr/bin/env ts-node
/**
 * enable-security-defaults.ts — Enable account-level security defaults.
 *
 * Runs in each member account (via assumeRole) to enable:
 *   1. Default EBS encryption
 *   2. S3 account-level Block Public Access
 *   3. IAM Access Analyzer (organization-wide, management account only)
 *
 * Usage:
 *   npx ts-node scripts/org/enable-security-defaults.ts [--config path/to/org-config.yaml]
 */

import type { AwsExecOptions } from "./aws-helpers";
import {
  assertManagementAccountContext,
  assertNonRootCaller,
  assumeRole,
  aws,
  awsJson,
  getCallerIdentity,
  getOrganizationManagementAccountId,
  log,
  logError,
  logStep,
  logSuccess,
  logWarn,
  resolveManagementProfile,
  sleep,
} from "./aws-helpers";
import { parseCliArgs } from "./cli";
import { parseOrgConfig } from "./parse-org-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAccountId(name: string, opts: AwsExecOptions = {}): string {
  const id = aws(
    `organizations list-accounts --query "Accounts[?Name==\\\`${name}\\\`].Id" --output text`,
    opts,
  );
  if (!id || id === "None") {
    throw new Error(
      `Could not resolve account ID for "${name}". Has build-org completed?`,
    );
  }
  return id.trim();
}

function enableEbsEncryption(
  region: string,
  env: Record<string, string>,
): void {
  try {
    aws(`ec2 enable-ebs-encryption-by-default --region ${region}`, { env });
    logSuccess("Default EBS encryption enabled.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("already enabled") ||
      message.includes("EbsEncryptionByDefault")
    ) {
      logStep("Default EBS encryption already enabled.");
    } else {
      throw err;
    }
  }
}

function enableS3BlockPublicAccess(
  accountId: string,
  region: string,
  env: Record<string, string>,
): void {
  try {
    aws(
      `s3control put-public-access-block --account-id ${accountId} --region ${region} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
      { env },
    );
    logSuccess("S3 account-level Block Public Access enabled.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`S3 Block Public Access: ${message}`);
  }
}

interface OrganizationsServiceAccessResult {
  EnabledServicePrincipals?: Array<{
    ServicePrincipal?: string;
  }>;
}

function hasAccessAnalyzerTrustedAccess(
  serviceAccess: OrganizationsServiceAccessResult,
): boolean {
  return (
    serviceAccess.EnabledServicePrincipals?.some(
      (entry) => entry.ServicePrincipal === "access-analyzer.amazonaws.com",
    ) ?? false
  );
}

async function ensureAccessAnalyzerServiceAccessEnabled(
  opts: AwsExecOptions = {},
): Promise<void> {
  const MAX_POLL_ATTEMPTS = 10;
  const POLL_INTERVAL_MS = 2000;

  const current = awsJson<OrganizationsServiceAccessResult>(
    "organizations list-aws-service-access-for-organization",
    opts,
  );
  if (hasAccessAnalyzerTrustedAccess(current)) {
    logStep("Trusted access already enabled for IAM Access Analyzer.");
    return;
  }

  aws(
    "organizations enable-aws-service-access --service-principal access-analyzer.amazonaws.com",
    opts,
  );
  logSuccess("Enabled trusted access for IAM Access Analyzer.");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const serviceAccess = awsJson<OrganizationsServiceAccessResult>(
      "organizations list-aws-service-access-for-organization",
      opts,
    );
    if (hasAccessAnalyzerTrustedAccess(serviceAccess)) {
      logSuccess("IAM Access Analyzer trusted access is active.");
      return;
    }

    if (attempt < MAX_POLL_ATTEMPTS) {
      logStep(
        `Waiting for IAM Access Analyzer trusted access propagation (attempt ${attempt}/${MAX_POLL_ATTEMPTS}). Retrying in ${POLL_INTERVAL_MS / 1000}s…`,
      );
      await sleep(POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    "Timed out waiting for IAM Access Analyzer trusted access to become visible in AWS Organizations. Verify management-account permissions and that Organizations is set to ALL features.",
  );
}

function enableAccessAnalyzer(region: string, opts: AwsExecOptions = {}): void {
  // Check if an organization analyzer already exists.
  const result = awsJson<{ analyzers: Array<{ name: string; type: string }> }>(
    `accessanalyzer list-analyzers --region ${region} --type ORGANIZATION`,
    opts,
  );

  const existing = result.analyzers.find((a) => a.type === "ORGANIZATION");

  if (existing) {
    logStep(`IAM Access Analyzer "${existing.name}" already exists.`);
    return;
  }

  try {
    aws(
      `accessanalyzer create-analyzer --analyzer-name org-analyzer --type ORGANIZATION --region ${region}`,
      opts,
    );
    logSuccess("IAM Access Analyzer (organization-wide) created.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ConflictException")) {
      logStep("IAM Access Analyzer already exists.");
    } else if (message.includes("ValidationException")) {
      throw new Error(
        `Unable to create organization Access Analyzer in ${region}. Trusted access may not be fully active yet. Original error: ${message}`,
      );
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = parseOrgConfig(args.config);

  // Resolve management profile from CLI or config
  const profile = resolveManagementProfile(
    args.managementProfile,
    config.managementProfile,
  );
  const managementAwsOpts: AwsExecOptions = profile ? { profile } : {};

  // Preflight checks
  if (profile) {
    logStep(`Using management profile: ${profile}`);
  }
  const identity = getCallerIdentity(managementAwsOpts);
  assertNonRootCaller(identity);
  const mgmtAccountId = getOrganizationManagementAccountId(managementAwsOpts);
  assertManagementAccountContext(identity.Account, mgmtAccountId);

  log("🔒", "Enabling security defaults across all member accounts…");

  // Enable Access Analyzer in the management account (org-wide).
  logStep(
    "Enabling IAM Access Analyzer (organization-wide) in management account…",
  );
  await ensureAccessAnalyzerServiceAccessEnabled(managementAwsOpts);
  enableAccessAnalyzer(config.region, managementAwsOpts);

  // Register Shared Services as CloudTrail delegated administrator.
  const sharedServicesAccount = config.accounts.find(
    (a) => a.role === "sharedServices",
  );
  if (sharedServicesAccount) {
    logStep(
      "Registering Shared Services as CloudTrail delegated administrator…",
    );
    const sharedServicesAccountId = resolveAccountId(
      sharedServicesAccount.name,
      managementAwsOpts,
    );

    // Enable trusted access for CloudTrail (idempotent).
    const serviceAccess = awsJson<OrganizationsServiceAccessResult>(
      "organizations list-aws-service-access-for-organization",
      managementAwsOpts,
    );
    const cloudTrailTrustedAccessEnabled =
      serviceAccess.EnabledServicePrincipals?.some(
        (entry) => entry.ServicePrincipal === "cloudtrail.amazonaws.com",
      ) ?? false;

    if (cloudTrailTrustedAccessEnabled) {
      logStep("Trusted access already enabled for CloudTrail.");
    } else {
      aws(
        "organizations enable-aws-service-access --service-principal cloudtrail.amazonaws.com",
        managementAwsOpts,
      );
      logSuccess("Enabled trusted access for CloudTrail.");
    }

    // Register delegated administrator if not already registered.
    // Use the CloudTrail API (not Organizations API) so that AWS automatically
    // creates the AWSServiceRoleForCloudTrail service-linked role in the
    // management account.
    const delegatedAdmins = awsJson<{
      DelegatedAdministrators: Array<{ Id: string }>;
    }>(
      "organizations list-delegated-administrators --service-principal cloudtrail.amazonaws.com",
      managementAwsOpts,
    );
    const alreadyRegistered = delegatedAdmins.DelegatedAdministrators?.some(
      (entry) => entry.Id === sharedServicesAccountId,
    );

    if (alreadyRegistered) {
      logStep(
        `Shared Services (${sharedServicesAccountId}) is already a CloudTrail delegated administrator.`,
      );
    } else {
      aws(
        `cloudtrail register-organization-delegated-admin --member-account-id ${sharedServicesAccountId}`,
        managementAwsOpts,
      );
      logSuccess(
        `Registered Shared Services (${sharedServicesAccountId}) as CloudTrail delegated administrator.`,
      );
    }
  }

  // Process each member account.
  for (const account of config.accounts) {
    const accountId = resolveAccountId(account.name, managementAwsOpts);
    log("🔹", `Processing ${account.name} (${accountId})…`);

    const creds = assumeRole(
      accountId,
      config.crossAccountRoleName,
      `${account.name.replace(/[^a-zA-Z0-9]/g, "")}SecurityDefaults`,
      managementAwsOpts,
    );
    const env = { ...creds };

    enableEbsEncryption(config.region, env);
    enableS3BlockPublicAccess(accountId, config.region, env);

    logSuccess(`${account.name} security defaults applied.`);
  }

  logSuccess("All accounts have security defaults enabled.");
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
