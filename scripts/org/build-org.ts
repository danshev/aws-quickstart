#!/usr/bin/env ts-node
/**
 * build-org.ts — Create the OU hierarchy and request account creation.
 *
 * Replaces: pre-bootstrap-scripts/build_org.sh
 *
 * Reads the organization tree from org-config.yaml, creates each OU, then
 * requests each account. Tracking state is written to .org-state.json so
 * subsequent scripts (move-accounts, etc.) can pick up where this left off.
 *
 * Usage:
 *   npx ts-node scripts/org/build-org.ts [--config path/to/org-config.yaml]
 */

import { parseOrgConfig } from "./parse-org-config";
import {
  aws,
  awsJson,
  log,
  logError,
  logStep,
  logSuccess,
  writeState,
} from "./aws-helpers";
import type { AccountRequest, OrgState, OuRecord } from "./types";
import { parseCliArgs } from "./cli";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OrgOuSummary {
  Id: string;
  Name: string;
}

interface OrgAccountSummary {
  Id: string;
  Name: string;
  Email?: string;
}

interface ListChildOusResponse {
  OrganizationalUnits?: OrgOuSummary[];
  NextToken?: string;
}

interface ListAccountsResponse {
  Accounts?: OrgAccountSummary[];
  NextToken?: string;
}

/**
 * List all immediate child OUs under a parent OU/root, handling pagination.
 */
export function listChildOus(
  parentId: string,
  listChildOusPage: (command: string) => ListChildOusResponse = (command) =>
    awsJson<ListChildOusResponse>(command),
): OrgOuSummary[] {
  const collected: OrgOuSummary[] = [];
  let nextToken: string | undefined;

  do {
    const startingTokenArg = nextToken
      ? ` --starting-token "${nextToken}"`
      : "";
    const page = listChildOusPage(
      `organizations list-organizational-units-for-parent --parent-id ${parentId}${startingTokenArg}`,
    );

    collected.push(...(page.OrganizationalUnits ?? []));
    nextToken = page.NextToken;
  } while (nextToken);

  return collected;
}

/**
 * List all AWS Organization accounts, handling pagination.
 */
export function listOrganizationAccounts(
  listAccountsPage: (command: string) => ListAccountsResponse = (command) =>
    awsJson<ListAccountsResponse>(command),
): OrgAccountSummary[] {
  const collected: OrgAccountSummary[] = [];
  let nextToken: string | undefined;

  do {
    const startingTokenArg = nextToken
      ? ` --starting-token "${nextToken}"`
      : "";
    const page = listAccountsPage(
      `organizations list-accounts${startingTokenArg}`,
    );

    collected.push(...(page.Accounts ?? []));
    nextToken = page.NextToken;
  } while (nextToken);

  return collected;
}

/**
 * Find a single OU by exact name under a specific parent.
 */
export function findExistingOuId(
  parentId: string,
  ouName: string,
  listChildOusFn: (parentId: string) => OrgOuSummary[] = listChildOus,
): string | undefined {
  const matches = listChildOusFn(parentId).filter((ou) => ou.Name === ouName);

  if (matches.length > 1) {
    throw new Error(
      `Multiple OUs named "${ouName}" found under parent "${parentId}". Resolve ambiguity before running org:build.`,
    );
  }

  return matches[0]?.Id;
}

/**
 * Find an existing account ID by email first, then by name.
 * Fails fast on ambiguous or conflicting matches.
 */
export function findExistingAccountId(
  params: { accountName: string; accountEmail?: string },
  listAccountsFn: () => OrgAccountSummary[] = listOrganizationAccounts,
): string | undefined {
  const { accountName, accountEmail } = params;
  const accounts = listAccountsFn();

  const emailMatches = accountEmail
    ? accounts.filter((account) => account.Email === accountEmail)
    : [];
  const nameMatches = accounts.filter(
    (account) => account.Name === accountName,
  );

  if (emailMatches.length > 1) {
    throw new Error(
      `Multiple accounts matched email "${accountEmail}". Resolve ambiguity before running org:build.`,
    );
  }

  if (nameMatches.length > 1) {
    throw new Error(
      `Multiple accounts matched name "${accountName}". Resolve ambiguity before running org:build.`,
    );
  }

  const emailMatch = emailMatches[0];
  const nameMatch = nameMatches[0];

  if (emailMatch && nameMatch && emailMatch.Id !== nameMatch.Id) {
    throw new Error(
      `Conflicting existing accounts detected for "${accountName}" / "${accountEmail}": email matched ${emailMatch.Id}, name matched ${nameMatch.Id}.`,
    );
  }

  return emailMatch?.Id ?? nameMatch?.Id;
}

function isDuplicateOuError(message: string): boolean {
  return (
    message.includes("DuplicateOrganizationalUnitException") ||
    message.includes("already exists")
  );
}

export function isExistingAccountError(message: string): boolean {
  const upper = message.toUpperCase();
  return (
    upper.includes("EMAIL_ALREADY_EXISTS") ||
    upper.includes("ACCOUNT_NAME_ALREADY_EXISTS") ||
    upper.includes("ACCOUNT_NAME_EXISTS")
  );
}

/**
 * Resolve an OU by parent+name or create it when missing.
 * Includes a race-safe fallback for duplicate-on-create behavior.
 */
export function resolveOrCreateOu(
  parentId: string,
  ouName: string,
  deps: {
    awsExec?: typeof aws;
    findExistingOuIdFn?: typeof findExistingOuId;
  } = {},
): { ouId: string; reused: boolean } {
  const awsExec = deps.awsExec ?? aws;
  const findOu = deps.findExistingOuIdFn ?? findExistingOuId;

  const existingId = findOu(parentId, ouName);
  if (existingId) {
    return { ouId: existingId, reused: true };
  }

  try {
    const ouId = awsExec(
      `organizations create-organizational-unit --parent-id ${parentId} --name "${ouName}" --query 'OrganizationalUnit.Id' --output text`,
    );
    return { ouId, reused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (!isDuplicateOuError(message)) {
      throw new Error(
        `Failed to resolve/create OU "${ouName}" under parent "${parentId}": ${message}`,
      );
    }

    const afterDuplicateId = findOu(parentId, ouName);
    if (afterDuplicateId) {
      return { ouId: afterDuplicateId, reused: true };
    }

    throw new Error(
      `OU "${ouName}" under parent "${parentId}" appears to already exist, but no unique OU ID could be resolved. Original error: ${message}`,
    );
  }
}

export interface ResolvedOu {
  path: string[];
  ouId: string;
  reused: boolean;
}

/**
 * Resolve all configured OU paths to OU IDs, reusing existing OUs when found.
 */
export function resolveOuHierarchy(
  ouPaths: string[][],
  rootId: string,
  resolveOrCreateFn: (
    parentId: string,
    ouName: string,
  ) => { ouId: string; reused: boolean } = resolveOrCreateOu,
): ResolvedOu[] {
  const ouIdMap = new Map<string, string>();
  const resolved: ResolvedOu[] = [];

  for (const ouPath of ouPaths) {
    const ouName = ouPath[ouPath.length - 1];
    const parentKey =
      ouPath.length === 1 ? null : ouPath.slice(0, -1).join("/");
    const parentId = parentKey ? ouIdMap.get(parentKey) : rootId;

    if (!parentId) {
      throw new Error(
        `Parent OU not found for ${ouPath.join("/")}. Is the config tree ordered correctly?`,
      );
    }

    const { ouId, reused } = resolveOrCreateFn(parentId, ouName);
    const key = ouPath.join("/");
    ouIdMap.set(key, ouId);
    resolved.push({ path: ouPath, ouId, reused });
  }

  return resolved;
}

export interface ResolvedAccountRequest {
  requestId: string;
  accountId?: string;
  reused: boolean;
}

/**
 * Reuse an existing account when found; otherwise request creation.
 * Includes a duplicate-on-create recovery path.
 */
export function resolveOrRequestAccount(
  params: {
    accountName: string;
    accountEmail: string;
  },
  deps: {
    awsExec?: typeof aws;
    findExistingAccountIdFn?: typeof findExistingAccountId;
  } = {},
): ResolvedAccountRequest {
  const awsExec = deps.awsExec ?? aws;
  const findAccountId = deps.findExistingAccountIdFn ?? findExistingAccountId;

  const existingId = findAccountId({
    accountName: params.accountName,
    accountEmail: params.accountEmail,
  });

  if (existingId) {
    return {
      requestId: `existing:${existingId}`,
      accountId: existingId,
      reused: true,
    };
  }

  try {
    const requestId = awsExec(
      `organizations create-account --email "${params.accountEmail}" --account-name "${params.accountName}" --query 'CreateAccountStatus.Id' --output text`,
    );

    return {
      requestId,
      reused: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isExistingAccountError(message)) {
      throw new Error(
        `Failed to resolve/create account "${params.accountName}" (${params.accountEmail}): ${message}`,
      );
    }

    const afterDuplicateId = findAccountId({
      accountName: params.accountName,
      accountEmail: params.accountEmail,
    });

    if (afterDuplicateId) {
      return {
        requestId: `existing:${afterDuplicateId}`,
        accountId: afterDuplicateId,
        reused: true,
      };
    }

    throw new Error(
      `Account "${params.accountName}" appears to already exist (email: ${params.accountEmail}), but no unique account ID could be resolved. Original error: ${message}`,
    );
  }
}

/**
 * Derive a "+"-style email alias from the management account email.
 *
 *   formatEmail("admin@corp.com", "App 1 (dev)")
 *   → "admin_dev-app-1@corp.com"
 */
function formatAccountEmail(rootEmail: string, accountName: string): string {
  const [localPart, domain] = rootEmail.split("@");

  let slug = accountName.toLowerCase();

  // Pull parenthesized content to the front: "App 1 (dev)" → "dev-app-1"
  const parenMatch = slug.match(/^(.*)\((.+)\)(.*)$/);
  if (parenMatch) {
    slug = `${parenMatch[2].trim()}-${parenMatch[1].trim()}${parenMatch[3].trim()}`;
  }

  slug = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return `${localPart}_${slug}@${domain}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = parseOrgConfig(args.config);

  log("🔍", "Gathering Organization info…");

  const rootId = aws(
    "organizations list-roots --query 'Roots[0].Id' --output text",
  );
  const mgmtEmail = aws(
    "organizations describe-organization --query 'Organization.MasterAccountEmail' --output text",
  );

  logSuccess(`Root ID: ${rootId}`);
  logSuccess(`Management email: ${mgmtEmail}`);

  // -- Create OUs (parents before children, already sorted by the parser) --

  log("🏗️", "Creating OUs…");

  const resolvedOus = resolveOuHierarchy(config.ous, rootId);
  const ouRecords: OuRecord[] = [];

  for (const ou of resolvedOus) {
    const key = ou.path.join("/");
    ouRecords.push({ path: ou.path, ouId: ou.ouId });
    logStep(`${key} → ${ou.ouId} (${ou.reused ? "reused" : "created"})`);
  }

  logSuccess("OU structure ready.");

  // -- Request account creation --

  log("🚀", "Requesting account creation…");

  const accountRequests: AccountRequest[] = [];

  for (const account of config.accounts) {
    const email = formatAccountEmail(mgmtEmail, account.name);
    logStep(`${account.name} (${email})…`);

    const resolvedAccount = resolveOrRequestAccount({
      accountName: account.name,
      accountEmail: email,
    });

    accountRequests.push({
      requestId: resolvedAccount.requestId,
      accountName: account.name,
      accountEmail: email,
      existingAccount: resolvedAccount.reused,
      targetOuPath: account.ouPath,
      accountId: resolvedAccount.accountId,
    });

    if (resolvedAccount.reused && resolvedAccount.accountId) {
      logSuccess(
        `${account.name} → ${resolvedAccount.accountId} (existing account reused)`,
      );
    }
  }

  // -- Persist state --

  const state: OrgState = {
    rootId,
    managementEmail: mgmtEmail,
    accountRequests,
    ous: ouRecords,
  };

  writeState(state);

  logSuccess("All account requests submitted.");
  log(
    "📝",
    "State saved to .org-state.json — run `npm run org:move` after accounts are created (~3 min).",
  );
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
