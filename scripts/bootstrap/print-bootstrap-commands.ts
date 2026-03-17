import { loadConfig } from "../../config/load-config";
import type { BootstrapConfig, DeploymentTarget } from "../../config/schema";

const ADMIN_POLICY_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";

function getWorkloadTargets(config: BootstrapConfig): DeploymentTarget[] {
  return config.apps.flatMap((app) => app.deploymentTargets);
}

function getUniqueTargetRegions(config: BootstrapConfig): string[] {
  return [
    ...new Set(getWorkloadTargets(config).map((target) => target.region)),
  ];
}

function getSecurityTargets(config: BootstrapConfig): DeploymentTarget[] {
  if (!config.security) {
    return [];
  }

  const securityRegion = config.apps[0]?.deploymentTargets[0]?.region;
  if (!securityRegion) {
    return [];
  }

  return [
    {
      name: "log-archive",
      accountId: config.security.logArchiveAccountId,
      region: securityRegion,
    },
    {
      name: "audit",
      accountId: config.security.auditAccountId,
      region: securityRegion,
    },
  ];
}

function getTrustTargets(config: BootstrapConfig): DeploymentTarget[] {
  const deduped = new Map<string, DeploymentTarget>();
  for (const target of [
    ...getWorkloadTargets(config),
    ...getSecurityTargets(config),
  ]) {
    const key = `${target.accountId}:${target.region}`;
    if (!deduped.has(key)) {
      deduped.set(key, target);
    }
  }
  return [...deduped.values()];
}

export function generateBootstrapCommands(config: BootstrapConfig): string[] {
  const lines: string[] = [];

  lines.push("# Bootstrap the Shared Services account");
  for (const region of getUniqueTargetRegions(config)) {
    lines.push(
      `cdk bootstrap aws://${config.sharedServicesAccountId}/${region}`,
    );
  }

  for (const target of getTrustTargets(config)) {
    lines.push("");
    lines.push(`# Bootstrap ${target.name} (trusting Shared Services)`);
    lines.push(`cdk bootstrap aws://${target.accountId}/${target.region} \\`);
    lines.push(`  --trust ${config.sharedServicesAccountId} \\`);
    lines.push(`  --cloudformation-execution-policies ${ADMIN_POLICY_ARN}`);
  }

  return lines;
}

if (require.main === module) {
  const config = loadConfig();
  console.log(generateBootstrapCommands(config).join("\n"));
}
