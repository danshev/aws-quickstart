#!/usr/bin/env ts-node
/**
 * bootstrap-cdk.ts — CDK-bootstrap every account in the org config.
 *
 * Replaces: pre-bootstrap-scripts/bootstrap_cdk.sh
 *
 * 1. Assumes the Shared Services role → bootstraps that account.
 * 2. For each non-Shared-Services account, assumes its role → bootstraps with
 *    --trust pointing to Shared Services.
 *
 * Account IDs are resolved from AWS Organizations using the account names
 * declared in org-config.yaml.
 *
 * Usage:
 *   npx ts-node scripts/org/bootstrap-cdk.ts [--config path/to/org-config.yaml] [--skip-existing-accounts]
 */

import { execSync } from "node:child_process";

import type { AwsExecOptions } from "./aws-helpers";
import {
  assertManagementAccountContext,
  assertNonRootCaller,
  assumeRole,
  aws,
  getCallerIdentity,
  getOrganizationManagementAccountId,
  log,
  logError,
  logStep,
  logSuccess,
  logWarn,
  readState,
  resolveManagementProfile,
} from "./aws-helpers";
import type { CliArgs } from "./cli";
import { parseCliArgs } from "./cli";
import { getSharedServicesAccount, parseOrgConfig } from "./parse-org-config";
import type { AccountRequest, OrgConfig } from "./types";

const ADMIN_POLICY_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";

interface BootstrapTarget {
  name: string;
  accountId: string;
  region: string;
  trustSharedServices: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up an account ID by its name via Organizations.
 */
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

/**
 * Run `cdk bootstrap` in a given account/region, optionally trusting another account.
 */
function cdkBootstrap(
  accountId: string,
  region: string,
  roleName: string,
  sessionName: string,
  trustAccountId?: string,
  opts: AwsExecOptions = {},
): void {
  const creds = assumeRole(accountId, roleName, sessionName, opts);

  let cmd = `npx cdk bootstrap aws://${accountId}/${region}`;
  if (trustAccountId) {
    cmd += ` --trust ${trustAccountId}`;
    cmd += ` --cloudformation-execution-policies ${ADMIN_POLICY_ARN}`;
  }

  logStep(cmd);

  execSync(cmd, {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...creds,
      AWS_PROFILE: "",
      CDK_BOOTSTRAP: "1",
    },
    stdio: "inherit",
  });
}

function isExistingRequest(request: AccountRequest): boolean {
  return (
    request.existingAccount === true ||
    request.requestId.startsWith("existing:")
  );
}

export function deriveExistingAccountNames(
  requests: AccountRequest[],
): Set<string> {
  return new Set(
    requests
      .filter((request) => isExistingRequest(request))
      .map((request) => request.accountName),
  );
}

export function filterBootstrapTargets(
  targets: BootstrapTarget[],
  existingNames: Set<string>,
): { targets: BootstrapTarget[]; skippedNames: string[] } {
  const skippedNames = targets
    .filter((target) => existingNames.has(target.name))
    .map((target) => target.name);

  return {
    targets: targets.filter((target) => !existingNames.has(target.name)),
    skippedNames,
  };
}

export function buildTargets(
  config: OrgConfig,
  sharedServicesName: string,
  opts: AwsExecOptions = {},
): {
  sharedServices: BootstrapTarget;
  others: BootstrapTarget[];
  all: BootstrapTarget[];
} {
  const sharedServices: BootstrapTarget = {
    name: sharedServicesName,
    accountId: resolveAccountId(sharedServicesName, opts),
    region: config.region,
    trustSharedServices: false,
  };

  const others: BootstrapTarget[] = [];
  for (const account of config.accounts) {
    if (account.role === "sharedServices") continue;
    const id = resolveAccountId(account.name, opts);
    logSuccess(`${account.name} → ${id}`);
    others.push({
      name: account.name,
      accountId: id,
      region: config.region,
      trustSharedServices: true,
    });
  }

  return {
    sharedServices,
    others,
    all: [sharedServices, ...others],
  };
}

export function resolveExistingAccountNamesFromState(
  stateReader: typeof readState = readState,
): Set<string> {
  try {
    const state = stateReader();
    return deriveExistingAccountNames(state.accountRequests);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg}\nRun \`npm run org:build\` (and typically \`npm run org:move\`) first, or rerun without \`--skip-existing-accounts\`.`,
    );
  }
}

export interface BootstrapPlan {
  sharedServicesTarget: BootstrapTarget;
  otherTargets: BootstrapTarget[];
  targetsToBootstrap: BootstrapTarget[];
  skippedNames: string[];
}

export interface BuildBootstrapPlanDeps {
  buildTargetsFn?: typeof buildTargets;
  resolveExistingAccountNamesFn?: () => Set<string>;
}

export function buildBootstrapPlan(
  config: OrgConfig,
  args: CliArgs,
  deps: BuildBootstrapPlanDeps = {},
): BootstrapPlan {
  const buildTargetsFn = deps.buildTargetsFn ?? buildTargets;
  const resolveExistingNames =
    deps.resolveExistingAccountNamesFn ?? resolveExistingAccountNamesFromState;

  const sharedSvcDef = getSharedServicesAccount(config);
  log("🔍", "Resolving account IDs from AWS Organizations…");

  const targets = buildTargetsFn(config, sharedSvcDef.name);
  logSuccess(`${sharedSvcDef.name} → ${targets.sharedServices.accountId}`);

  let targetsToBootstrap = targets.all;
  let skippedNames: string[] = [];

  if (args.skipExistingAccounts) {
    const existingNames = resolveExistingNames();
    const filtered = filterBootstrapTargets(targets.all, existingNames);
    targetsToBootstrap = filtered.targets;
    skippedNames = filtered.skippedNames;
  }

  return {
    sharedServicesTarget: targets.sharedServices,
    otherTargets: targets.others,
    targetsToBootstrap,
    skippedNames,
  };
}

export function getSkippedTrustTargetNames(plan: BootstrapPlan): string[] {
  if (plan.skippedNames.length === 0) {
    return [];
  }

  const skipped = new Set(plan.skippedNames);
  return plan.otherTargets
    .filter((target) => target.trustSharedServices && skipped.has(target.name))
    .map((target) => target.name);
}

function runBootstrapPlan(
  config: OrgConfig,
  plan: BootstrapPlan,
  managementAwsOpts: AwsExecOptions = {},
): void {
  log(
    "📋",
    `Bootstrap plan: ${plan.targetsToBootstrap.length + plan.skippedNames.length} configured account(s), ${plan.skippedNames.length} skipped existing account(s), ${plan.targetsToBootstrap.length} account(s) to bootstrap.`,
  );
  if (plan.skippedNames.length > 0) {
    logStep(`Skipping existing accounts: ${plan.skippedNames.join(", ")}`);
  }
  const skippedTrustTargets = getSkippedTrustTargetNames(plan);
  if (skippedTrustTargets.length > 0) {
    logWarn(
      `Skipped account(s) that require trust bootstrap: ${skippedTrustTargets.join(", ")}. If trust is missing, rerun without --skip-existing-accounts or run targeted cdk bootstrap commands with --trust.`,
    );
  }

  const sharedSvcId = plan.sharedServicesTarget.accountId;
  const sharedSvcIncluded = plan.targetsToBootstrap.some(
    (target) => target.name === plan.sharedServicesTarget.name,
  );

  if (sharedSvcIncluded) {
    log("🏗️", `Bootstrapping Shared Services (${sharedSvcId})…`);
    cdkBootstrap(
      sharedSvcId,
      config.region,
      config.crossAccountRoleName,
      "SharedSvcBootstrap",
      undefined,
      managementAwsOpts,
    );
    logSuccess("Shared Services bootstrapped.");
  } else {
    logWarn("Shared Services bootstrap skipped (--skip-existing-accounts).");
  }

  const othersToBootstrap = plan.targetsToBootstrap.filter(
    (target) => target.name !== plan.sharedServicesTarget.name,
  );

  for (const acct of othersToBootstrap) {
    log(
      "🏗️",
      `Bootstrapping ${acct.name} (${acct.accountId}), trusting ${sharedSvcId}…`,
    );
    cdkBootstrap(
      acct.accountId,
      acct.region,
      config.crossAccountRoleName,
      `${acct.name.replace(/[^a-zA-Z0-9]/g, "")}Bootstrap`,
      sharedSvcId,
      managementAwsOpts,
    );
    logSuccess(`${acct.name} bootstrapped.`);
  }

  logSuccess(
    `Bootstrap run complete. Bootstrapped ${plan.targetsToBootstrap.length} account(s), skipped ${plan.skippedNames.length} existing account(s).`,
  );
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
    const identity = getCallerIdentity(managementAwsOpts);
    assertNonRootCaller(identity);
    const mgmtAccountId = getOrganizationManagementAccountId(managementAwsOpts);
    assertManagementAccountContext(identity.Account, mgmtAccountId);
  }

  const plan = buildBootstrapPlan(config, args);
  runBootstrapPlan(config, plan, managementAwsOpts);
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
