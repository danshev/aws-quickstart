#!/usr/bin/env ts-node
/**
 * add-app.ts — Add a new app to org-config.yaml.
 *
 * Creates account entries under each existing stage OU (e.g. Dev, Prod) and
 * appends a new entry to the `apps[]` array. Uses YAML document-level editing
 * to preserve comments.
 *
 * Usage:
 *   npx ts-node scripts/org/add-app.ts --name app2 --repoName MyNewRepo
 *   npx ts-node scripts/org/add-app.ts --name my-api --repoName MyApiRepo --repoBranch develop
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { log, logError, logSuccess } from "./aws-helpers";
import { parseOrgConfig } from "./parse-org-config";
import type { OrgConfig } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable display name from an app identifier.
 *
 *   "app2"   → "App 2"
 *   "my-api" → "My Api"
 */
export function deriveDisplayName(name: string): string {
  return name
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Convert a kebab/snake/camel identifier to PascalCase.
 *
 *   "app2"   → "App2"
 *   "my-api" → "MyApi"
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** A stage discovered from existing accounts in the org config. */
export interface StageInfo {
  stage: string;
  ouPath: string[];
  requiresManualApproval: boolean;
}

/**
 * Scan existing accounts for unique stage values and their OU paths.
 */
export function discoverStages(config: OrgConfig): StageInfo[] {
  const seen = new Map<string, StageInfo>();
  for (const account of config.accounts) {
    if (account.stage && !seen.has(account.stage)) {
      seen.set(account.stage, {
        stage: account.stage,
        ouPath: account.ouPath,
        requiresManualApproval: account.requiresManualApproval ?? false,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Add a new app to YAML content, preserving comments.
 *
 * Inserts account nodes under existing stage OUs, appends to `apps[]`,
 * sets `triggerOnPaths` for the new app, and adds an exclude to the
 * infra pipeline so it doesn't trigger on the new app's files.
 * Returns the modified YAML string.
 */
export function addAppToYaml(
  yamlContent: string,
  appName: string,
  displayName: string,
  pipelineName: string,
  connectionArn: string,
  owner: string,
  repoName: string,
  repoBranch: string,
  stages: StageInfo[],
): string {
  const doc = YAML.parseDocument(yamlContent);

  // --- Insert account nodes under the correct OUs ---

  const orgNode = doc.get("organization", true);
  if (!YAML.isMap(orgNode)) {
    throw new Error("Could not find 'organization' map in YAML.");
  }

  for (const stageInfo of stages) {
    const accountName = `${displayName} (${stageInfo.stage})`;

    // Navigate to the parent OU: e.g. ["Workloads", "Dev"]
    let current: unknown = orgNode;
    for (const segment of stageInfo.ouPath) {
      if (!YAML.isMap(current)) {
        throw new Error(
          `Expected a map at OU path segment "${segment}", got ${typeof current}`,
        );
      }
      current = (current as YAML.YAMLMap).get(segment, true);
    }

    if (!YAML.isMap(current)) {
      throw new Error(
        `OU path ${stageInfo.ouPath.join("/")} did not resolve to a map.`,
      );
    }

    // Build the account node
    const accountMap = doc.createNode({
      account: true,
      app: appName,
      stage: stageInfo.stage,
      requiresManualApproval: stageInfo.requiresManualApproval,
    });
    accountMap.spaceBefore = true;

    (current as YAML.YAMLMap).add(doc.createPair(accountName, accountMap));
  }

  // --- Append to apps[] with triggerOnPaths ---

  const appsNode = doc.get("apps", true);
  if (!YAML.isSeq(appsNode)) {
    throw new Error("Could not find 'apps' sequence in YAML.");
  }

  const newAppEntry = doc.createNode({
    name: appName,
    pipeline: {
      name: pipelineName,
      connectionArn,
      owner,
      repositoryName: repoName,
      repositoryBranch: repoBranch,
      crossAccountKeys: true,
      triggerOnPaths: {
        filePathsIncludes: [`lib/${appName}/**`, `packages/${appName}/**`],
      },
    },
  });

  appsNode.add(newAppEntry);

  // --- Add exclude to infraPipeline.triggerOnPaths ---

  const infraNode = doc.get("infraPipeline", true);
  if (YAML.isMap(infraNode)) {
    const triggerNode = infraNode.get("triggerOnPaths", true);

    if (!triggerNode || !YAML.isMap(triggerNode)) {
      // Create triggerOnPaths node if it doesn't exist
      const newTrigger = doc.createNode({
        filePathsExcludes: [`lib/${appName}/**`],
      });
      infraNode.set("triggerOnPaths", newTrigger);
    } else {
      const excludesNode = (triggerNode as YAML.YAMLMap).get(
        "filePathsExcludes",
        true,
      );

      if (!excludesNode || !YAML.isSeq(excludesNode)) {
        // Create filePathsExcludes if it doesn't exist
        (triggerNode as YAML.YAMLMap).set(
          "filePathsExcludes",
          doc.createNode([`lib/${appName}/**`]),
        );
      } else {
        (excludesNode as YAML.YAMLSeq).add(`lib/${appName}/**`);
      }
    }
  }

  return doc.toString();
}

// ---------------------------------------------------------------------------
// Directory scaffolding
// ---------------------------------------------------------------------------

/**
 * Generate the `app-stage.ts` template for a new app.
 */
export function generateAppStageTemplate(appName: string): string {
  const pascal = toPascalCase(appName);
  return `import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { AppStageProps } from "../app-stage-props";
import {
  AppResourcesStack,
  type DomainProps,
} from "./stacks/app-resources-stack";
import { SpokeNetworkStack } from "../infra/spoke-network-stack";

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function resolveStageDomain(stageName: string, rootDomain: string): string {
  return stageName === "prod" ? rootDomain : \`\${stageName}.\${rootDomain}\`;
}

export class AppStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    let domainProps: DomainProps | undefined;

    if (props.domainConfig && props.sharedServicesAccountId) {
      domainProps = {
        domainConfig: props.domainConfig,
        stageDomain: resolveStageDomain(
          props.stageName,
          props.domainConfig.rootDomain,
        ),
        sharedServicesAccountId: props.sharedServicesAccountId,
      };
    }

    new AppResourcesStack(
      this,
      \`\${toPascalCase(props.stageName)}${pascal}AppResources\`,
      {
        stageName: props.stageName,
        domainProps,
        env: props.env,
      },
    );

    if (props.spokeCidr) {
      new SpokeNetworkStack(
        this,
        \`\${toPascalCase(props.stageName)}SpokeNetwork\`,
        {
          stageName: props.stageName,
          spokeCidr: props.spokeCidr,
          sharedServicesAccountId: props.sharedServicesAccountId ?? "",
          env: props.env,
        },
      );
    }

    if (props.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(key, value);
      }
    }
  }
}
`;
}

/**
 * Generate the `stacks/app-resources-stack.ts` template for a new app.
 */
export function generateAppResourcesTemplate(appName: string): string {
  return `import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { DomainConfig } from "../../../config/schema";
import { MediaCdn } from "../../constructs/media-cdn";

export interface DomainProps {
  readonly domainConfig: DomainConfig;
  readonly stageDomain: string;
  readonly sharedServicesAccountId: string;
}

export interface AppResourcesStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly domainProps?: DomainProps;
}

export class AppResourcesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppResourcesStackProps) {
    super(scope, id, props);

    const { stageName, domainProps } = props;

    // ── S3 Media Bucket ───────────────────────────────────────────────

    const mediaBucket = new s3.Bucket(this, "MediaBucket", {
      bucketName: \`${appName}-media-\${stageName}\`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy:
        stageName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stageName !== "prod",
    });

    // ── Media CDN ─────────────────────────────────────────────────────

    if (domainProps) {
      const mediaCdn = new MediaCdn(this, "MediaCdn", {
        stageName,
        stageDomain: domainProps.stageDomain,
        rootDomain: domainProps.domainConfig.rootDomain,
        sharedServicesAccountId: domainProps.sharedServicesAccountId,
        delegationRoleName: domainProps.domainConfig.delegationRoleName,
        mediaBucket,
      });

      new cdk.CfnOutput(this, "MediaUrl", {
        value: \`https://\${mediaCdn.mediaDomain}/\`,
        description: "Custom media URL served via CloudFront.",
      });
    } else {
      const distribution = new cloudfront.Distribution(this, "MediaCdn", {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        comment: \`Media CDN (\${stageName})\`,
      });

      new cdk.CfnOutput(this, "CdnDomainName", {
        value: distribution.distributionDomainName,
        description: "CloudFront domain name (no custom domain).",
      });
    }

    // ── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "StageName", {
      value: stageName,
      description: "Deployment stage identifier for this stack.",
    });

    new cdk.CfnOutput(this, "MediaBucketName", {
      value: mediaBucket.bucketName,
      description: "Name of the media S3 bucket.",
    });
  }
}
`;
}

/**
 * Scaffold a minimal CDK directory for a new app under `lib/<appName>/`.
 * Skips if the directory already exists (idempotent).
 * Returns true if files were created, false if skipped.
 */
export function scaffoldAppDirectory(
  appName: string,
  projectRoot: string,
): boolean {
  const appDir = path.join(projectRoot, "lib", appName);

  if (fs.existsSync(appDir)) {
    return false;
  }

  const stacksDir = path.join(appDir, "stacks");
  fs.mkdirSync(stacksDir, { recursive: true });

  fs.writeFileSync(
    path.join(appDir, "app-stage.ts"),
    generateAppStageTemplate(appName),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(stacksDir, "app-resources-stack.ts"),
    generateAppResourcesTemplate(appName),
    "utf-8",
  );

  return true;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface AddAppArgs {
  name: string;
  repoName: string;
  displayName?: string;
  repoBranch: string;
  pipelineName?: string;
  config: string;
}

function printHelp(): void {
  console.log(`Usage: ts-node scripts/org/add-app.ts [options]

Options:
  --name <id>            App identifier, e.g. "app2" (required)
  --repoName <name>      GitHub repository name (required)
  --displayName <name>   Human name for accounts (default: derived from --name)
  --repoBranch <branch>  Repository branch (default: "main")
  --pipelineName <name>  Pipeline name (default: "<PascalCase>Pipeline")
  --config <path>        Path to org-config.yaml (default: scripts/org/org-config.yaml)
  --help                 Show this message
`);
}

function parseArgs(): AddAppArgs {
  const argv = process.argv.slice(2);
  let name: string | undefined;
  let repoName: string | undefined;
  let displayName: string | undefined;
  let repoBranch = "main";
  let pipelineName: string | undefined;
  let config = path.resolve(__dirname, "org-config.yaml");

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--name":
        name = next;
        i++;
        break;
      case "--repoName":
        repoName = next;
        i++;
        break;
      case "--displayName":
        displayName = next;
        i++;
        break;
      case "--repoBranch":
        repoBranch = next;
        i++;
        break;
      case "--pipelineName":
        pipelineName = next;
        i++;
        break;
      case "--config":
        config = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) {
          console.warn(`Unknown flag: ${flag}`);
        }
    }
  }

  if (!name) {
    logError("--name is required. Run with --help for usage.");
    process.exit(1);
  }
  if (!repoName) {
    logError("--repoName is required. Run with --help for usage.");
    process.exit(1);
  }

  return { name, repoName, displayName, repoBranch, pipelineName, config };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // Validate current config
  const config = parseOrgConfig(args.config);
  const resolvedDisplayName = args.displayName ?? deriveDisplayName(args.name);
  const resolvedPipelineName =
    args.pipelineName ?? `${toPascalCase(args.name)}Pipeline`;

  // Check for duplicates
  const existingApp = config.apps.find((a) => a.name === args.name);
  if (existingApp) {
    throw new Error(`App "${args.name}" already exists in the apps[] array.`);
  }

  const existingAccount = config.accounts.find((a) => a.app === args.name);
  if (existingAccount) {
    throw new Error(
      `An account with app: "${args.name}" already exists ("${existingAccount.name}").`,
    );
  }

  // Discover stages from existing accounts
  const stages = discoverStages(config);
  if (stages.length === 0) {
    throw new Error(
      "No stages found in the existing config. At least one account with a stage is required.",
    );
  }

  log(
    "📦",
    `Adding app "${args.name}" (${resolvedDisplayName}) with ${stages.length} stage(s): ${stages.map((s) => s.stage).join(", ")}`,
  );

  // Inherit connectionArn and owner from infra pipeline
  const { connectionArn, owner } = config.infraPipeline;

  // Round-trip YAML edit
  const yamlContent = fs.readFileSync(args.config, "utf-8");
  const updatedYaml = addAppToYaml(
    yamlContent,
    args.name,
    resolvedDisplayName,
    resolvedPipelineName,
    connectionArn,
    owner,
    args.repoName,
    args.repoBranch,
    stages,
  );

  fs.writeFileSync(args.config, updatedYaml, "utf-8");

  logSuccess(`Updated ${args.config}`);

  // Scaffold CDK directory
  const projectRoot = path.resolve(__dirname, "..", "..");
  const created = scaffoldAppDirectory(args.name, projectRoot);
  if (created) {
    logSuccess(
      `Scaffolded lib/${args.name}/ with app-stage.ts and stacks/app-resources-stack.ts`,
    );
  } else {
    log("ℹ️", `lib/${args.name}/ already exists — skipping scaffold`);
  }

  // Print next steps
  log("📋", "Next steps:");
  console.log(`
  1. Review lib/${args.name}/                     # Customize stacks as needed
  2. npm run org:build                           # Create new accounts
  3. npm run org:move                            # Move accounts to target OUs (~3 min)
  4. npm run org:bootstrap                       # CDK bootstrap with trust
  5. npm run org:finalize                        # Regenerate config/defaults.ts
  6. source ./scripts/act-as-account.sh <shared-services-account-id>
  7. npm run synth && npm run deploy             # Deploy the new pipeline
  8. git push origin main                        # Triggers the pipeline via CodeConnections
`);
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
