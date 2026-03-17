import * as cdk from "aws-cdk-lib";
import { ComputeType } from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import type { Construct } from "constructs";
import * as path from "node:path";
import type { AppConfig } from "../../config/schema";
import type { AppStageProps } from "../app-stage-props";
import {
  assertConnectionArnMatchesEnvironment,
  assertValidConnectionArn,
  connectionArnToUseConnectionActions,
} from "./connection-arn";

export interface AppPipelineStackProps extends cdk.StackProps {
  readonly appConfig: AppConfig;
  readonly sharedServicesAccountId: string;
  readonly networkEnabled?: boolean;
}

function toStageId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export class AppPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppPipelineStackProps) {
    super(scope, id, props);

    const { appConfig } = props;
    const triggerOnPaths = appConfig.pipeline.triggerOnPaths;
    const parsedConnectionArn = assertValidConnectionArn(
      appConfig.pipeline.connectionArn,
      `Pipeline "${appConfig.pipeline.name}"`,
    );
    assertConnectionArnMatchesEnvironment(parsedConnectionArn, {
      label: `Pipeline "${appConfig.pipeline.name}"`,
      expectedAccountId: this.account,
      expectedRegion: this.region,
    });

    const source = CodePipelineSource.connection(
      `${appConfig.pipeline.owner}/${appConfig.pipeline.repositoryName}`,
      appConfig.pipeline.repositoryBranch,
      {
        connectionArn: appConfig.pipeline.connectionArn,
        triggerOnPush: false,
      },
    );

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: appConfig.pipeline.name,
      crossAccountKeys: appConfig.pipeline.crossAccountKeys,
      pipelineType: codepipeline.PipelineType.V2,
      synth: new ShellStep("Synth", {
        input: source,
        commands: [
          "n 20",
          "npm install -g pnpm",
          "pnpm install --frozen-lockfile",
          "pnpm run build",
          "pnpm -r run build",
          "npx cdk synth",
        ],
      }),
      codeBuildDefaults: {
        buildEnvironment: {
          computeType: ComputeType.LARGE,
        },
      },
    });

    // ── Resolve per-app AppStage class ─────────────────────────────────
    const appStagePath = path.resolve(
      __dirname,
      "..",
      appConfig.name,
      "app-stage",
    );
    const { AppStage } = require(appStagePath) as {
      AppStage: new (
        scope: Construct,
        id: string,
        props: AppStageProps,
      ) => cdk.Stage;
    };

    // ── Workload Stages ───────────────────────────────────────────────
    for (const target of appConfig.deploymentTargets) {
      const stageId = toStageId(target.name);

      pipeline.addStage(
        new AppStage(this, stageId, {
          stageName: target.name,
          appConfig,
          deploymentTarget: target,
          sharedServicesAccountId: props.sharedServicesAccountId,
          env: {
            account: target.accountId,
            region: target.region,
          },
          tags: {
            Environment: target.name,
          },
        }),
        target.requiresManualApproval
          ? { pre: [new ManualApprovalStep(`PromoteTo${stageId}`)] }
          : {},
      );
    }

    // ── V2 Trigger (always explicit, path filters optional) ────────────
    pipeline.buildPipeline();
    const appConfigResources = [
      `arn:${this.partition}:appconfig:${this.region}:${this.account}:application/*`,
      `arn:${this.partition}:appconfig:${this.region}:${this.account}:application/*/environment/*`,
      `arn:${this.partition}:appconfig:${this.region}:${this.account}:application/*/environment/*/deployment/*`,
    ];

    pipeline.pipeline.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: connectionArnToUseConnectionActions(parsedConnectionArn),
        resources: [parsedConnectionArn.arn],
      }),
    );

    // Grant UseConnection to the source action's dedicated role (not just the pipeline role).
    // CDK creates a separate action role when crossAccountKeys is enabled. CDK's auto-grant
    // only covers codestar-connections:UseConnection, which is insufficient for codeconnections: ARNs.
    for (const child of pipeline.pipeline.node.findAll()) {
      if (
        child instanceof iam.Role &&
        child.node.path.includes("/Source/") &&
        child.node.id === "CodePipelineActionRole"
      ) {
        child.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: connectionArnToUseConnectionActions(parsedConnectionArn),
            resources: [parsedConnectionArn.arn],
          }),
        );
      }
    }

    pipeline.pipeline.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "appconfig:StartDeployment",
          "appconfig:GetDeployment",
          "appconfig:StopDeployment",
        ],
        resources: appConfigResources,
      }),
    );
    const cfnPipeline = pipeline.pipeline.node.defaultChild as cdk.CfnResource;
    cfnPipeline.addPropertyOverride(
      "Stages.0.Actions.0.Configuration.OutputArtifactFormat",
      "CODE_ZIP",
    );

    const sourceAction = pipeline.pipeline.stages[0]?.actions[0];
    if (!sourceAction) {
      throw new Error(
        `Pipeline "${appConfig.pipeline.name}" has no source action to attach a V2 trigger.`,
      );
    }
    if (
      sourceAction.actionProperties.provider !==
      codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION
    ) {
      throw new Error(
        `Pipeline "${appConfig.pipeline.name}" source action provider must be "${codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION}", got "${sourceAction.actionProperties.provider}".`,
      );
    }

    const pushFilter: codepipeline.GitPushFilter = {
      branchesIncludes: [appConfig.pipeline.repositoryBranch],
      ...(triggerOnPaths?.filePathsIncludes?.length
        ? { filePathsIncludes: triggerOnPaths.filePathsIncludes }
        : {}),
      ...(triggerOnPaths?.filePathsExcludes?.length
        ? { filePathsExcludes: triggerOnPaths.filePathsExcludes }
        : {}),
    };

    pipeline.pipeline.addTrigger({
      providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
      gitConfiguration: {
        sourceAction,
        pushFilter: [pushFilter],
      },
    });
  }
}
