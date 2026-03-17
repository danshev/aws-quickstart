#!/usr/bin/env ts-node
/**
 * finalize.ts — Generate config/defaults.ts from the org config + live AWS data.
 *
 * Replaces: pre-bootstrap-scripts/finalize.sh
 *
 * Looks up each account's ID via AWS Organizations (by name), then writes a
 * fully typed config/defaults.ts that matches the BootstrapConfig schema.
 *
 * Usage:
 *   npx ts-node scripts/org/finalize.ts [--config path/to/org-config.yaml]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { aws, log, logError, logSuccess } from "./aws-helpers";
import { parseCliArgs } from "./cli";
import {
  getDeploymentTargetsByApp,
  getSharedServicesAccount,
  parseOrgConfig,
} from "./parse-org-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAccountId(name: string): string {
  const id = aws(
    `organizations list-accounts --query "Accounts[?Name==\\\`${name}\\\`].Id" --output text`,
  );
  if (!id || id === "None") {
    throw new Error(
      `Could not resolve account ID for "${name}". Has build-org completed?`,
    );
  }
  return id.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = parseOrgConfig(args.config);

  log("🔍", "Resolving account IDs from AWS Organizations…");

  const sharedSvcDef = getSharedServicesAccount(config);
  const sharedSvcId = resolveAccountId(sharedSvcDef.name);
  logSuccess(`${sharedSvcDef.name} → ${sharedSvcId}`);

  // -- Resolve security accounts (Log Archive + Audit) --

  const logArchiveAccount = config.accounts.find(
    (a) => a.role === "logArchive",
  );
  const auditAccount = config.accounts.find((a) => a.role === "audit");

  let logArchiveId: string | undefined;
  let auditId: string | undefined;

  if (logArchiveAccount && auditAccount) {
    logArchiveId = resolveAccountId(logArchiveAccount.name);
    logSuccess(`${logArchiveAccount.name} (logArchive) → ${logArchiveId}`);
    auditId = resolveAccountId(auditAccount.name);
    logSuccess(`${auditAccount.name} (audit) → ${auditId}`);
  }

  // -- Resolve deployment targets by app --

  const targetsByApp = getDeploymentTargetsByApp(config);

  const appsLiterals: string[] = [];
  for (const appConfig of config.apps) {
    const targets = targetsByApp.get(appConfig.name) ?? [];

    const resolvedTargets: Array<{
      name: string;
      accountId: string;
      region: string;
      requiresManualApproval: boolean;
      spokeCidr?: string;
    }> = [];

    for (const target of targets) {
      const stage = target.stage ?? target.name;
      const id = resolveAccountId(target.name);
      logSuccess(`${target.name} (${stage}) → ${id}`);
      const spokeCidr = config.network?.spokeCidrs[stage];
      resolvedTargets.push({
        name: stage,
        accountId: id,
        region: config.region,
        requiresManualApproval: target.requiresManualApproval ?? false,
        spokeCidr,
      });
    }

    const targetsLiteral = resolvedTargets
      .map((t) => {
        let s =
          `        {\n` +
          `          name: "${t.name}",\n` +
          `          accountId: "${t.accountId}",\n` +
          `          region: "${t.region}",\n` +
          `          requiresManualApproval: ${t.requiresManualApproval},\n`;
        if (t.spokeCidr) {
          s += `          spokeCidr: "${t.spokeCidr}",\n`;
        }
        s += `        }`;
        return s;
      })
      .join(",\n");

    let appTriggerLiteral = "";
    if (appConfig.pipeline.triggerOnPaths) {
      const tp = appConfig.pipeline.triggerOnPaths;
      appTriggerLiteral += `        triggerOnPaths: {\n`;
      if (tp.filePathsIncludes) {
        appTriggerLiteral += `          filePathsIncludes: [${tp.filePathsIncludes.map((p) => `"${p}"`).join(", ")}],\n`;
      }
      if (tp.filePathsExcludes) {
        appTriggerLiteral += `          filePathsExcludes: [${tp.filePathsExcludes.map((p) => `"${p}"`).join(", ")}],\n`;
      }
      appTriggerLiteral += `        },\n`;
    }

    const appLiteral =
      `    {\n` +
      `      name: "${appConfig.name}",\n` +
      `      pipeline: {\n` +
      `        name: "${appConfig.pipeline.name}",\n` +
      `        connectionArn: "${appConfig.pipeline.connectionArn}",\n` +
      `        owner: "${appConfig.pipeline.owner}",\n` +
      `        repositoryName: "${appConfig.pipeline.repositoryName}",\n` +
      `        repositoryBranch: "${appConfig.pipeline.repositoryBranch}",\n` +
      `        crossAccountKeys: ${appConfig.pipeline.crossAccountKeys},\n` +
      appTriggerLiteral +
      `      },\n` +
      `      deploymentTargets: [\n${targetsLiteral},\n` +
      `      ],\n` +
      `    }`;

    appsLiterals.push(appLiteral);
  }

  // -- Generate config/defaults.ts --

  let securityLiteral = "";
  if (logArchiveId && auditId) {
    securityLiteral =
      `  security: {\n` +
      `    logArchiveAccountId: "${logArchiveId}",\n` +
      `    auditAccountId: "${auditId}",\n` +
      `  },\n`;
  }

  let networkLiteral = "";
  if (config.network) {
    networkLiteral =
      `  network: {\n` +
      `    egressVpcCidr: "${config.network.egressVpcCidr}",\n` +
      (config.network.tgwAsn !== undefined
        ? `    tgwAsn: ${config.network.tgwAsn},\n`
        : "") +
      `  },\n`;
  }

  let infraTriggerLiteral = "";
  if (config.infraPipeline.triggerOnPaths) {
    const tp = config.infraPipeline.triggerOnPaths;
    infraTriggerLiteral += `    triggerOnPaths: {\n`;
    if (tp.filePathsIncludes) {
      infraTriggerLiteral += `      filePathsIncludes: [${tp.filePathsIncludes.map((p) => `"${p}"`).join(", ")}],\n`;
    }
    if (tp.filePathsExcludes) {
      infraTriggerLiteral += `      filePathsExcludes: [${tp.filePathsExcludes.map((p) => `"${p}"`).join(", ")}],\n`;
    }
    infraTriggerLiteral += `    },\n`;
  }

  const fileContent = `import type { BootstrapConfig } from "./schema";

export const defaultConfig: BootstrapConfig = {
  sharedServicesAccountId: "${sharedSvcId}",
  infraPipeline: {
    name: "${config.infraPipeline.name}",
    connectionArn: "${config.infraPipeline.connectionArn}",
    owner: "${config.infraPipeline.owner}",
    repositoryName: "${config.infraPipeline.repositoryName}",
    repositoryBranch: "${config.infraPipeline.repositoryBranch}",
    crossAccountKeys: ${config.infraPipeline.crossAccountKeys},
${infraTriggerLiteral}  },
${securityLiteral}${networkLiteral}  apps: [
${appsLiterals.join(",\n")},
  ],
};
`;

  const configDir = path.resolve(process.cwd(), "config");
  const configFile = path.join(configDir, "defaults.ts");

  if (!fs.existsSync(configDir)) {
    throw new Error(`Config directory not found at ${configDir}`);
  }

  fs.writeFileSync(configFile, fileContent, "utf-8");

  logSuccess(`Written ${configFile}`);
  log("📝", "config/defaults.ts is now in sync with your AWS Organization.");

  // -- Move root README to SETUP and leave an empty README in place --
  const rootDir = process.cwd();
  const readmeFile = path.join(rootDir, "README.md");
  const setupFile = path.join(rootDir, "SETUP.md");

  if (fs.existsSync(readmeFile) && !fs.existsSync(setupFile)) {
    fs.renameSync(readmeFile, setupFile);
    logSuccess(`Renamed ${readmeFile} → ${setupFile}`);
  } else if (fs.existsSync(readmeFile) && fs.existsSync(setupFile)) {
    log("ℹ️", "SETUP.md already exists; skipping README.md rename.");
  } else if (!fs.existsSync(readmeFile) && !fs.existsSync(setupFile)) {
    log("ℹ️", "README.md not found; skipping rename to SETUP.md.");
  }

  fs.writeFileSync(readmeFile, "", "utf-8");
  logSuccess(`Created empty ${readmeFile}`);
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
