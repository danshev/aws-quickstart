import * as fs from "node:fs";
import * as path from "node:path";
import { assertValidConnectionArn } from "../lib/pipeline/connection-arn";
import { defaultConfig } from "./defaults";
import type {
  BootstrapConfig,
  PipelineConfig,
  TriggerPathFilter,
} from "./schema";

const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const CIDR_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

function parseCidr(cidr: string): { start: number; end: number } | null {
  const match = cidr.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/,
  );
  if (!match) return null;
  const [, a, b, c, d, prefix] = match;
  const ip =
    (Number(a) << 24) | (Number(b) << 16) | (Number(c) << 8) | Number(d);
  const bits = Number(prefix);
  if (bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const start = (ip & mask) >>> 0;
  const end = (start | ~mask) >>> 0;
  return { start, end };
}

function cidrsOverlap(a: string, b: string): boolean {
  const ra = parseCidr(a);
  const rb = parseCidr(b);
  if (!ra || !rb) return false;
  return ra.start <= rb.end && rb.start <= ra.end;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readLocalOverride(): Partial<BootstrapConfig> {
  const candidateFiles = [
    path.resolve(process.cwd(), "config", "local.ts"),
    path.resolve(process.cwd(), "config", "local.js"),
  ];

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const moduleValue = require(filePath) as {
      default?: Partial<BootstrapConfig>;
      localConfig?: Partial<BootstrapConfig>;
    };

    return moduleValue.localConfig ?? moduleValue.default ?? {};
  }

  return {};
}

export function mergeBootstrapConfig(
  base: BootstrapConfig,
  override: Partial<BootstrapConfig>,
): BootstrapConfig {
  const merged: BootstrapConfig = {
    ...base,
    ...override,
    infraPipeline: {
      ...base.infraPipeline,
      ...(override.infraPipeline ?? {}),
    },
    apps: override.apps ?? base.apps,
  };

  // Security: same merge pattern as domain
  if ("security" in override) {
    merged.security = override.security
      ? { ...base.security, ...override.security }
      : undefined;
  }

  // Network: same pattern as security
  if ("network" in override) {
    merged.network = override.network
      ? { ...base.network, ...override.network }
      : undefined;
  }

  return merged;
}

function validateTriggerOnPaths(
  filter: TriggerPathFilter,
  label: string,
): void {
  if (filter.filePathsIncludes && filter.filePathsIncludes.length > 8) {
    throw new Error(
      `${label} triggerOnPaths.filePathsIncludes exceeds the maximum of 8 entries.`,
    );
  }
  if (filter.filePathsExcludes && filter.filePathsExcludes.length > 8) {
    throw new Error(
      `${label} triggerOnPaths.filePathsExcludes exceeds the maximum of 8 entries.`,
    );
  }
}

function validatePipelineConfig(pipeline: PipelineConfig, label: string): void {
  if (!isNonEmptyString(pipeline.name)) {
    throw new Error(`${label} name cannot be empty.`);
  }
  if (!isNonEmptyString(pipeline.connectionArn)) {
    throw new Error(`${label} connectionArn cannot be empty.`);
  }
  assertValidConnectionArn(pipeline.connectionArn, label);
  if (!isNonEmptyString(pipeline.owner)) {
    throw new Error(`${label} owner cannot be empty.`);
  }
  if (!isNonEmptyString(pipeline.repositoryName)) {
    throw new Error(`${label} repositoryName cannot be empty.`);
  }
  if (!isNonEmptyString(pipeline.repositoryBranch)) {
    throw new Error(`${label} repositoryBranch cannot be empty.`);
  }
  if (pipeline.triggerOnPaths) {
    validateTriggerOnPaths(pipeline.triggerOnPaths, label);
  }
}

export function validateConfig(config: BootstrapConfig): void {
  if (!ACCOUNT_ID_PATTERN.test(config.sharedServicesAccountId)) {
    throw new Error(
      `Invalid sharedServicesAccountId "${config.sharedServicesAccountId}". Expected a 12-digit AWS account ID.`,
    );
  }

  // ── Infra pipeline ──────────────────────────────────────────────
  validatePipelineConfig(config.infraPipeline, "Pipeline");

  // ── Apps ─────────────────────────────────────────────────────────
  if (config.apps.length === 0) {
    throw new Error("At least one app is required.");
  }

  const appNames = new Set<string>();
  const allAccountIds = new Set<string>();

  for (const app of config.apps) {
    if (!isNonEmptyString(app.name)) {
      throw new Error("App name cannot be empty.");
    }

    if (appNames.has(app.name)) {
      throw new Error(`Duplicate app name "${app.name}".`);
    }
    appNames.add(app.name);

    validatePipelineConfig(app.pipeline, `App "${app.name}" pipeline`);

    const targetNames = new Set<string>();

    for (const target of app.deploymentTargets) {
      if (!isNonEmptyString(target.name)) {
        throw new Error(
          `Deployment target name cannot be empty in app "${app.name}".`,
        );
      }

      if (targetNames.has(target.name)) {
        throw new Error(
          `Duplicate deployment target name "${target.name}" in app "${app.name}".`,
        );
      }
      targetNames.add(target.name);

      if (!ACCOUNT_ID_PATTERN.test(target.accountId)) {
        throw new Error(
          `Invalid accountId "${target.accountId}" for target "${target.name}". Expected a 12-digit AWS account ID.`,
        );
      }

      if (allAccountIds.has(target.accountId)) {
        throw new Error(
          `Duplicate accountId "${target.accountId}" across apps. Each target must use a unique account.`,
        );
      }
      allAccountIds.add(target.accountId);

      if (!isNonEmptyString(target.region)) {
        throw new Error(
          `Invalid region "${target.region}" for target "${target.name}". Region cannot be empty.`,
        );
      }
    }

    // Per-app apolloGraphQL validation
    if (app.apolloGraphQL) {
      const { lambdaMemoryMb, lambdaTimeoutSeconds, passwordMinLength } =
        app.apolloGraphQL;
      if (
        lambdaMemoryMb !== undefined &&
        (lambdaMemoryMb < 128 || lambdaMemoryMb > 10240)
      ) {
        throw new Error(
          `Invalid apolloGraphQL.lambdaMemoryMb "${lambdaMemoryMb}" in app "${app.name}". Must be between 128 and 10240.`,
        );
      }
      if (
        lambdaTimeoutSeconds !== undefined &&
        (lambdaTimeoutSeconds < 1 || lambdaTimeoutSeconds > 900)
      ) {
        throw new Error(
          `Invalid apolloGraphQL.lambdaTimeoutSeconds "${lambdaTimeoutSeconds}" in app "${app.name}". Must be between 1 and 900.`,
        );
      }
      if (
        passwordMinLength !== undefined &&
        (passwordMinLength < 8 || passwordMinLength > 99)
      ) {
        throw new Error(
          `Invalid apolloGraphQL.passwordMinLength "${passwordMinLength}" in app "${app.name}". Must be between 8 and 99.`,
        );
      }
      const { provisionedConcurrency } = app.apolloGraphQL;
      if (provisionedConcurrency !== undefined && provisionedConcurrency < 0) {
        throw new Error(
          `Invalid apolloGraphQL.provisionedConcurrency "${provisionedConcurrency}" in app "${app.name}". Must be >= 0.`,
        );
      }
    }

    // Per-app domain validation
    if (app.domain) {
      if (!isNonEmptyString(app.domain.rootDomain)) {
        throw new Error(
          `Domain rootDomain cannot be empty in app "${app.name}".`,
        );
      }
      if (!isNonEmptyString(app.domain.delegationRoleName)) {
        throw new Error(
          `Domain delegationRoleName cannot be empty in app "${app.name}".`,
        );
      }
    }
  }

  // ── Security ─────────────────────────────────────────────────────
  if (config.security) {
    if (!ACCOUNT_ID_PATTERN.test(config.security.logArchiveAccountId)) {
      throw new Error(
        `Invalid security.logArchiveAccountId "${config.security.logArchiveAccountId}". Expected a 12-digit AWS account ID.`,
      );
    }
    if (!ACCOUNT_ID_PATTERN.test(config.security.auditAccountId)) {
      throw new Error(
        `Invalid security.auditAccountId "${config.security.auditAccountId}". Expected a 12-digit AWS account ID.`,
      );
    }
    if (
      config.security.monthlyBudgetUsd !== undefined &&
      config.security.monthlyBudgetUsd <= 0
    ) {
      throw new Error(
        `Invalid security.monthlyBudgetUsd "${config.security.monthlyBudgetUsd}". Must be a positive number.`,
      );
    }
  }

  // ── Network + spoke CIDRs ───────────────────────────────────────
  if (config.network) {
    if (!CIDR_PATTERN.test(config.network.egressVpcCidr)) {
      throw new Error(
        `Invalid egressVpcCidr "${config.network.egressVpcCidr}". Expected CIDR notation (e.g. "10.0.0.0/16").`,
      );
    }

    const allCidrs: { label: string; cidr: string }[] = [
      { label: "egressVpcCidr", cidr: config.network.egressVpcCidr },
    ];

    for (const app of config.apps) {
      for (const target of app.deploymentTargets) {
        if (!target.spokeCidr) {
          throw new Error(
            `Missing spokeCidr for deployment target "${target.name}" in app "${app.name}".`,
          );
        }
        if (!CIDR_PATTERN.test(target.spokeCidr)) {
          throw new Error(
            `Invalid spokeCidr "${target.spokeCidr}" for target "${target.name}" in app "${app.name}". Expected CIDR notation (e.g. "10.1.0.0/16").`,
          );
        }
        allCidrs.push({
          label: `${app.name}.${target.name}.spokeCidr`,
          cidr: target.spokeCidr,
        });
      }
    }

    // Check for overlapping CIDRs
    for (let i = 0; i < allCidrs.length; i++) {
      for (let j = i + 1; j < allCidrs.length; j++) {
        if (cidrsOverlap(allCidrs[i].cidr, allCidrs[j].cidr)) {
          throw new Error(
            `Overlapping CIDRs: ${allCidrs[i].label} (${allCidrs[i].cidr}) overlaps with ${allCidrs[j].label} (${allCidrs[j].cidr}).`,
          );
        }
      }
    }
  }
}

export function resolveConfig(
  override: Partial<BootstrapConfig> = {},
): BootstrapConfig {
  const merged = mergeBootstrapConfig(defaultConfig, override);
  validateConfig(merged);
  return merged;
}

export function loadConfig(): BootstrapConfig {
  return resolveConfig(readLocalOverride());
}
