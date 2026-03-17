#!/usr/bin/env ts-node
/**
 * deploy-scps.ts — Deploy Service Control Policies to the AWS Organization.
 *
 * Creates (or updates) preventive SCPs and attaches them to the org root.
 * Runs from the management account (like all org scripts). Idempotent: checks
 * if each SCP exists by name before creating, and updates the policy document
 * if it has changed.
 *
 * Usage:
 *   npx ts-node scripts/org/deploy-scps.ts [--config path/to/org-config.yaml]
 */

import {
  aws,
  awsJson,
  log,
  logError,
  logStep,
  logSuccess,
  sleep,
} from "./aws-helpers";
import { parseCliArgs } from "./cli";
import { parseOrgConfig } from "./parse-org-config";

// ---------------------------------------------------------------------------
// SCP definitions
// ---------------------------------------------------------------------------

interface ScpDefinition {
  name: string;
  description: string;
  document: Record<string, unknown>;
}

function buildScps(
  allowedRegions: string[],
  crossAccountRoleName: string,
): ScpDefinition[] {
  return [
    {
      name: "deny-leave-org",
      description: "Prevent member accounts from leaving the organization.",
      document: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyLeaveOrganization",
            Effect: "Deny",
            Action: "organizations:LeaveOrganization",
            Resource: "*",
          },
        ],
      },
    },
    {
      name: "deny-cloudtrail-tampering",
      description:
        "Prevent deletion or modification of CloudTrail trails and S3 account-level Block Public Access settings.",
      document: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyCloudTrailTampering",
            Effect: "Deny",
            Action: [
              "cloudtrail:CreateTrail",
              "cloudtrail:DeleteTrail",
              "cloudtrail:StopLogging",
              "cloudtrail:UpdateTrail",
            ],
            Resource: "*",
            Condition: {
              ArnNotLike: {
                "aws:PrincipalArn": [
                  `arn:aws:iam::*:role/${crossAccountRoleName}`,
                  "arn:aws:iam::*:role/cdk-hnb659fds-cfn-exec-role-*-*",
                ],
              },
            },
          },
          {
            Sid: "DenyS3PublicAccessChange",
            Effect: "Deny",
            Action: "s3:PutAccountPublicAccessBlock",
            Resource: "*",
            Condition: {
              ArnNotLike: {
                "aws:PrincipalArn": `arn:aws:iam::*:role/${crossAccountRoleName}`,
              },
            },
          },
        ],
      },
    },
    {
      name: "deny-root-user",
      description:
        "Deny all actions by the root user except break-glass scenarios.",
      document: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyRootUser",
            Effect: "Deny",
            NotAction: [
              "iam:CreateServiceLinkedRole",
              "iam:DeleteServiceLinkedRole",
              "sts:GetSessionToken",
              "support:*",
            ],
            Resource: "*",
            Condition: {
              StringLike: {
                "aws:PrincipalArn": "arn:aws:iam::*:root",
              },
            },
          },
        ],
      },
    },
    {
      name: "deny-unused-regions",
      description: `Deny actions outside allowed regions (${allowedRegions.join(", ")}) except for global services.`,
      document: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyUnusedRegions",
            Effect: "Deny",
            NotAction: [
              "a4b:*",
              "budgets:*",
              "ce:*",
              "cloudfront:*",
              "globalaccelerator:*",
              "iam:*",
              "importexport:*",
              "organizations:*",
              "route53:*",
              "route53domains:*",
              "sts:*",
              "support:*",
              "waf:*",
              "bedrock:*",
            ],
            Resource: "*",
            Condition: {
              StringNotEquals: {
                "aws:RequestedRegion": allowedRegions,
              },
            },
          },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PolicySummary {
  Id: string;
  Name: string;
}

interface RootSummary {
  Id: string;
  PolicyTypes?: Array<{
    Type: string;
    Status: string;
  }>;
}

function listScps(): PolicySummary[] {
  const result = awsJson<{ Policies: PolicySummary[] }>(
    "organizations list-policies --filter SERVICE_CONTROL_POLICY",
  );
  return result.Policies;
}

function getOrgRootId(): string {
  const result = awsJson<{ Roots: RootSummary[] }>("organizations list-roots");
  if (result.Roots.length === 0) {
    throw new Error("No organization root found.");
  }
  return result.Roots[0].Id;
}

function getScpPolicyTypeStatus(rootId: string): string {
  const result = awsJson<{ Roots: RootSummary[] }>("organizations list-roots");
  const root = result.Roots.find((entry) => entry.Id === rootId);
  if (!root) {
    throw new Error(`Organization root not found: ${rootId}`);
  }

  const policyType = root.PolicyTypes?.find(
    (entry) => entry.Type === "SERVICE_CONTROL_POLICY",
  );
  return policyType?.Status ?? "UNKNOWN";
}

function getPolicyDocument(policyId: string): string {
  const result = awsJson<{
    Policy?: {
      PolicySummary?: { Id: string };
      Content?: string;
    };
  }>(`organizations describe-policy --policy-id ${policyId}`);

  const content = result.Policy?.Content;
  if (!content) {
    throw new Error(
      `describe-policy returned empty content for policy ${policyId} (command: organizations describe-policy --policy-id ${policyId})`,
    );
  }

  return content;
}

function isPolicyAttached(policyId: string, targetId: string): boolean {
  const result = awsJson<{ Policies: PolicySummary[] }>(
    `organizations list-policies-for-target --target-id ${targetId} --filter SERVICE_CONTROL_POLICY`,
  );
  return result.Policies.some((p) => p.Id === policyId);
}

async function ensureScpPolicyTypeEnabled(rootId: string): Promise<void> {
  const MAX_ENABLEMENT_ATTEMPTS = 30;
  const ENABLEMENT_POLL_INTERVAL_MS = 2000;
  const initialStatus = getScpPolicyTypeStatus(rootId);
  if (initialStatus === "ENABLED") {
    logStep("SERVICE_CONTROL_POLICY already enabled.");
    return;
  }

  try {
    aws(
      `organizations enable-policy-type --root-id ${rootId} --policy-type SERVICE_CONTROL_POLICY`,
    );
    logSuccess("Requested SERVICE_CONTROL_POLICY policy type enablement.");
  } catch (err) {
    const statusAfterEnableError = getScpPolicyTypeStatus(rootId);
    if (statusAfterEnableError !== "ENABLED") {
      throw err;
    }
    logStep("SERVICE_CONTROL_POLICY already enabled.");
  }

  let lastStatus = "UNKNOWN";
  for (let attempt = 1; attempt <= MAX_ENABLEMENT_ATTEMPTS; attempt++) {
    const status = getScpPolicyTypeStatus(rootId);
    lastStatus = status;

    if (status === "ENABLED") {
      logSuccess("SERVICE_CONTROL_POLICY policy type is ENABLED.");
      return;
    }

    if (attempt < MAX_ENABLEMENT_ATTEMPTS) {
      logStep(
        `Waiting for SERVICE_CONTROL_POLICY enablement (status: ${status}, attempt ${attempt}/${MAX_ENABLEMENT_ATTEMPTS}). Retrying in ${ENABLEMENT_POLL_INTERVAL_MS / 1000}s…`,
      );
      await sleep(ENABLEMENT_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `Timed out waiting for SERVICE_CONTROL_POLICY to reach ENABLED on root ${rootId}. Last observed status: ${lastStatus}. Verify AWS Organizations settings and re-run 'npm run org:scps'.`,
  );
}

async function attachPolicyToRootWithRetry(
  policyId: string,
  rootId: string,
  policyName: string,
): Promise<void> {
  const MAX_ATTACH_ATTEMPTS = 5;
  const ATTACH_RETRY_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_ATTACH_ATTEMPTS; attempt++) {
    try {
      aws(
        `organizations attach-policy --policy-id ${policyId} --target-id ${rootId}`,
      );
      logSuccess(`Attached "${policyName}" to root.`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = message.includes("PolicyTypeNotEnabledException");
      if (retryable && attempt < MAX_ATTACH_ATTEMPTS) {
        logStep(
          `SCP policy type not ready while attaching "${policyName}" (attempt ${attempt}/${MAX_ATTACH_ATTEMPTS}). Retrying in ${ATTACH_RETRY_DELAY_MS / 1000}s…`,
        );
        await sleep(ATTACH_RETRY_DELAY_MS);
        continue;
      }
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

  const allowedRegions = [config.region];
  const scps = buildScps(allowedRegions, config.crossAccountRoleName);

  log("🛡️", "Deploying Service Control Policies…");

  const rootId = getOrgRootId();
  await ensureScpPolicyTypeEnabled(rootId);

  const existingPolicies = listScps();

  for (const scp of scps) {
    const desiredContent = JSON.stringify(scp.document);
    const existing = existingPolicies.find((p) => p.Name === scp.name);

    if (existing) {
      // Check if the policy document needs updating.
      const currentContent = getPolicyDocument(existing.Id);
      let currentNormalized: string;
      try {
        currentNormalized = JSON.stringify(JSON.parse(currentContent));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to parse existing SCP "${scp.name}" (${existing.Id}) content as JSON: ${message}`,
        );
      }

      if (currentNormalized !== desiredContent) {
        logStep(`Updating SCP "${scp.name}"…`);
        aws(
          `organizations update-policy --policy-id ${existing.Id} --content '${desiredContent}'`,
        );
        logSuccess(`Updated "${scp.name}".`);
      } else {
        logStep(`SCP "${scp.name}" is already up to date.`);
      }

      // Ensure attached to root.
      if (!isPolicyAttached(existing.Id, rootId)) {
        await attachPolicyToRootWithRetry(existing.Id, rootId, scp.name);
      }
    } else {
      // Create the SCP.
      logStep(`Creating SCP "${scp.name}"…`);
      const result = awsJson<{ Policy: { PolicySummary: { Id: string } } }>(
        `organizations create-policy --name ${scp.name} --description "${scp.description}" --type SERVICE_CONTROL_POLICY --content '${desiredContent}'`,
      );
      const policyId = result.Policy.PolicySummary.Id;
      logSuccess(`Created "${scp.name}" (${policyId}).`);

      // Attach to root.
      await attachPolicyToRootWithRetry(policyId, rootId, scp.name);
    }
  }

  logSuccess("All SCPs deployed.");
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
