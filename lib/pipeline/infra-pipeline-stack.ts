import * as cdk from "aws-cdk-lib";
import { ComputeType } from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import type { Construct } from "constructs";
import type { BootstrapConfig, DomainConfig } from "../../config/schema";
import { SecurityStage } from "../infra/security-stage";
import { SharedServicesStage } from "../infra/shared-services-stage";
import {
  assertConnectionArnMatchesEnvironment,
  assertValidConnectionArn,
  connectionArnToUseConnectionActions,
} from "./connection-arn";

export interface InfraPipelineStackProps extends cdk.StackProps {
  readonly config: BootstrapConfig;
}

export class InfraPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraPipelineStackProps) {
    super(scope, id, props);

    const { config } = props;
    const triggerOnPaths = config.infraPipeline.triggerOnPaths;
    const parsedConnectionArn = assertValidConnectionArn(
      config.infraPipeline.connectionArn,
      `Pipeline "${config.infraPipeline.name}"`,
    );
    assertConnectionArnMatchesEnvironment(parsedConnectionArn, {
      label: `Pipeline "${config.infraPipeline.name}"`,
      expectedAccountId: this.account,
      expectedRegion: this.region,
    });

    const source = CodePipelineSource.connection(
      `${config.infraPipeline.owner}/${config.infraPipeline.repositoryName}`,
      config.infraPipeline.repositoryBranch,
      {
        connectionArn: config.infraPipeline.connectionArn,
        triggerOnPush: false,
      },
    );

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: config.infraPipeline.name,
      crossAccountKeys: config.infraPipeline.crossAccountKeys,
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

    // ── Security Stage ────────────────────────────────────────────────
    if (config.security) {
      const region =
        process.env.CDK_DEFAULT_REGION ??
        config.apps[0]?.deploymentTargets[0]?.region;

      pipeline.addStage(
        new SecurityStage(this, "Security", {
          securityConfig: config.security,
          sharedServicesAccountId: config.sharedServicesAccountId,
          organizationId: this.node.tryGetContext("organizationId") ?? "",
          env: {
            account: config.security.logArchiveAccountId,
            region,
          },
        }),
      );
    }

    // ── Shared Services Stage ─────────────────────────────────────────
    const appDomains = config.apps
      .map((a) => a.domain)
      .filter((d): d is DomainConfig => !!d);
    const domainConfig = appDomains[0];

    if (domainConfig || config.network) {
      const trustedAccountIds = config.apps.flatMap((a) =>
        a.deploymentTargets.map((t) => t.accountId),
      );
      const spokeCidrs = config.apps
        .flatMap((a) => a.deploymentTargets.map((t) => t.spokeCidr))
        .filter((c): c is string => !!c);

      pipeline.addStage(
        new SharedServicesStage(this, "SharedServices", {
          domainConfig,
          egressVpcCidr: config.network?.egressVpcCidr,
          spokeCidrs,
          tgwAsn: config.network?.tgwAsn,
          trustedAccountIds,
          env: {
            account: config.sharedServicesAccountId,
            region:
              process.env.CDK_DEFAULT_REGION ??
              config.apps[0]?.deploymentTargets[0]?.region,
          },
        }),
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
    pipeline.pipeline.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["codecommit:GetRepository"],
        resources: ["*"],
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
        `Pipeline "${config.infraPipeline.name}" has no source action to attach a V2 trigger.`,
      );
    }
    if (
      sourceAction.actionProperties.provider !==
      codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION
    ) {
      throw new Error(
        `Pipeline "${config.infraPipeline.name}" source action provider must be "${codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION}", got "${sourceAction.actionProperties.provider}".`,
      );
    }

    const pushFilter: codepipeline.GitPushFilter = {
      branchesIncludes: [config.infraPipeline.repositoryBranch],
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
