#!/usr/bin/env ts-node
/**
 * move-accounts.ts — Wait for account creation and move them under their OUs.
 *
 * Replaces: pre-bootstrap-scripts/move_accounts.sh
 *
 * Reads .org-state.json (written by build-org.ts), polls
 * `describe-create-account-status` until all accounts are ready, then moves
 * each account from the org root to its target OU.
 *
 * Usage:
 *   npx ts-node scripts/org/move-accounts.ts [--config path/to/org-config.yaml]
 */

import {
  aws,
  awsJson,
  log,
  logError,
  logStep,
  logSuccess,
  logWarn,
  readState,
  sleep,
  writeState,
} from "./aws-helpers";
import { findExistingAccountId, isExistingAccountError } from "./build-org";
import type { AccountRequest } from "./types";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 10_000; // 10 seconds

interface CreateAccountStatusResponse {
  CreateAccountStatus: {
    State: string;
    AccountId?: string;
    FailureReason?: string;
  };
}

interface ListParentsResponse {
  Parents?: Array<{ Id: string; Type: string }>;
}

export function getCurrentParentId(
  accountId: string,
  listParentsExec: (command: string) => ListParentsResponse = (command) =>
    awsJson<ListParentsResponse>(command),
): string {
  const response = listParentsExec(
    `organizations list-parents --child-id ${accountId}`,
  );
  const parentId = response.Parents?.[0]?.Id;

  if (!parentId) {
    throw new Error(
      `Unable to determine current parent for account ${accountId}.`,
    );
  }

  return parentId;
}

export function recoverAccountIdFromExistingFailure(
  req: AccountRequest,
  findExistingAccountIdFn: typeof findExistingAccountId = findExistingAccountId,
): string | undefined {
  return findExistingAccountIdFn({
    accountName: req.accountName,
    accountEmail: req.accountEmail,
  });
}

export function moveAccountWithCurrentParent(
  accountId: string,
  targetOuId: string,
  deps: {
    awsExec?: typeof aws;
    getCurrentParentIdFn?: typeof getCurrentParentId;
  } = {},
): "already-in-target" | "moved" {
  const awsExec = deps.awsExec ?? aws;
  const getParentId = deps.getCurrentParentIdFn ?? getCurrentParentId;

  const sourceParentId = getParentId(accountId);
  if (sourceParentId === targetOuId) {
    return "already-in-target";
  }

  awsExec(
    `organizations move-account --account-id ${accountId} --source-parent-id ${sourceParentId} --destination-parent-id ${targetOuId}`,
  );
  return "moved";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const state = readState();

  log("🔍", "Loaded state from .org-state.json");
  log(
    "📋",
    `${state.accountRequests.length} account(s) to process, ${state.ous.length} OU(s) on record.`,
  );

  // Build a lookup from OU path → OU ID.
  const ouIdMap = new Map<string, string>();
  for (const ou of state.ous) {
    ouIdMap.set(ou.path.join("/"), ou.ouId);
  }

  // -- Poll until all accounts are created --

  const pending = new Set(
    state.accountRequests.filter((r) => !r.accountId).map((r) => r.requestId),
  );

  if (pending.size > 0) {
    log("⏳", `Waiting for ${pending.size} account(s) to finish creating…`);
  }

  for (
    let attempt = 1;
    attempt <= MAX_POLL_ATTEMPTS && pending.size > 0;
    attempt++
  ) {
    for (const req of state.accountRequests) {
      if (!pending.has(req.requestId)) continue;

      const status = awsJson<CreateAccountStatusResponse>(
        `organizations describe-create-account-status --create-account-request-id ${req.requestId}`,
      );

      const { State, AccountId, FailureReason } = status.CreateAccountStatus;

      if (State === "SUCCEEDED" && AccountId) {
        req.accountId = AccountId;
        pending.delete(req.requestId);
        logSuccess(`${req.accountName} → ${AccountId}`);
      } else if (State === "FAILED") {
        if (FailureReason && isExistingAccountError(FailureReason)) {
          const recoveredId = recoverAccountIdFromExistingFailure(req);
          if (recoveredId) {
            req.accountId = recoveredId;
            pending.delete(req.requestId);
            logWarn(
              `${req.accountName} creation reported "${FailureReason}". Recovered existing account ID: ${recoveredId}.`,
            );
            continue;
          }

          pending.delete(req.requestId);
          logError(
            `${req.accountName} creation reported "${FailureReason}", but no matching existing account could be resolved (email: ${req.accountEmail ?? "n/a"}).`,
          );
          continue;
        }

        pending.delete(req.requestId);
        logError(
          `${req.accountName} creation failed: ${FailureReason ?? "unknown reason"}`,
        );
      }
      // else still IN_PROGRESS — keep polling.
    }

    if (pending.size > 0) {
      logStep(
        `${pending.size} account(s) still pending (attempt ${attempt}/${MAX_POLL_ATTEMPTS}). Retrying in ${POLL_INTERVAL_MS / 1000}s…`,
      );
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (pending.size > 0) {
    logError(
      `Timed out waiting for ${pending.size} account(s). Re-run this script to try again.`,
    );
  }

  // Persist any newly resolved account IDs before moving.
  writeState(state);

  // -- Move accounts --

  log("🚚", "Moving accounts to target OUs…");

  for (const req of state.accountRequests) {
    if (!req.accountId) {
      logWarn(`Skipping ${req.accountName} — no account ID yet.`);
      continue;
    }

    const targetKey = req.targetOuPath.join("/");
    const targetOuId = ouIdMap.get(targetKey);

    if (!targetOuId) {
      logError(
        `No OU ID found for path "${targetKey}". Was build-org.ts run successfully?`,
      );
      continue;
    }

    logStep(
      `${req.accountName} (${req.accountId}) → ${targetKey} (${targetOuId})`,
    );

    try {
      const moveResult = moveAccountWithCurrentParent(
        req.accountId,
        targetOuId,
      );
      if (moveResult === "already-in-target") {
        logWarn(`${req.accountName} was already under the target OU.`);
        continue;
      }
      logSuccess(`Moved ${req.accountName}.`);
    } catch (err) {
      // Common case: account was already moved in a prior run.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("DuplicateAccountException") ||
        msg.includes("AccountAlreadyRegisteredException")
      ) {
        logWarn(`${req.accountName} was already under the target OU.`);
      } else {
        logError(`Failed to move ${req.accountName}: ${msg}`);
      }
    }
  }

  // Final state write.
  writeState(state);

  logSuccess("All done. Accounts are under their target OUs.");
  log("📝", "Updated .org-state.json with resolved account IDs.");
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
