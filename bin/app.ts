#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../config/load-config";
import { AppPipelineStack } from "../lib/pipeline/app-pipeline-stack";
import { InfraPipelineStack } from "../lib/pipeline/infra-pipeline-stack";

function toStageId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const app = new cdk.App();

if (process.env.CDK_BOOTSTRAP) {
  // CDK CLI requires at least one stack even for `cdk bootstrap`.
  // This placeholder is never deployed — bootstrap uses its own CDKToolkit stack.
  new cdk.Stack(app, "BootstrapPlaceholder");
  app.synth();
  process.exit(0);
}

const config = loadConfig();

const sharedServicesRegion =
  process.env.CDK_DEFAULT_REGION ??
  config.apps[0]?.deploymentTargets[0]?.region;

if (!sharedServicesRegion) {
  throw new Error(
    "Unable to determine a region for the Shared Services pipeline stack. Set CDK_DEFAULT_REGION or define at least one app with a deployment target.",
  );
}

const sharedServicesEnv = {
  account: config.sharedServicesAccountId,
  region: sharedServicesRegion,
};

// ── Infrastructure Pipeline ─────────────────────────────────────────
new InfraPipelineStack(app, "InfraPipeline", {
  config,
  env: sharedServicesEnv,
});

// ── Per-App Pipelines ───────────────────────────────────────────────
for (const appConfig of config.apps) {
  const appId = toStageId(appConfig.name);
  new AppPipelineStack(app, `${appId}Pipeline`, {
    appConfig,
    sharedServicesAccountId: config.sharedServicesAccountId,
    networkEnabled: !!config.network,
    env: sharedServicesEnv,
  });
}
