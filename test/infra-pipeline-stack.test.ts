import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapConfig } from "../config/schema";
import { InfraPipelineStack } from "../lib/pipeline/infra-pipeline-stack";

interface PipelineAction {
  Name: string;
  ActionTypeId: {
    Category: string;
    Provider: string;
  };
  Configuration: {
    ConnectionArn?: string;
    DetectChanges?: boolean;
    OutputArtifactFormat?: string;
  };
}

interface PipelineResource {
  Properties: {
    Stages: Array<{
      Name: string;
      Actions: PipelineAction[];
    }>;
    Triggers?: Array<{
      ProviderType: string;
      GitConfiguration: {
        SourceActionName: string;
        Push: Array<{
          Branches?: { Includes?: string[] };
          FilePaths?: { Includes?: string[]; Excludes?: string[] };
        }>;
      };
    }>;
  };
}

const testConfig: BootstrapConfig = {
  sharedServicesAccountId: "111111111111",
  infraPipeline: {
    name: "TestInfraPipeline",
    connectionArn:
      "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
    owner: "test-owner",
    repositoryName: "TestRepo",
    repositoryBranch: "main",
    crossAccountKeys: true,
  },
  apps: [
    {
      name: "reboot",
      pipeline: {
        name: "RebootPipeline",
        connectionArn:
          "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
        owner: "test-owner",
        repositoryName: "TestRepo",
        repositoryBranch: "main",
        crossAccountKeys: true,
      },
      deploymentTargets: [
        {
          name: "dev",
          accountId: "222222222222",
          region: "us-east-1",
        },
        {
          name: "prod",
          accountId: "333333333333",
          region: "us-east-1",
          requiresManualApproval: true,
        },
      ],
    },
  ],
};

const securityConfig: BootstrapConfig = {
  ...testConfig,
  security: {
    logArchiveAccountId: "444444444444",
    auditAccountId: "555555555555",
  },
};

const networkConfig: BootstrapConfig = {
  ...testConfig,
  network: {
    egressVpcCidr: "10.0.0.0/16",
  },
  apps: [
    {
      ...testConfig.apps[0],
      deploymentTargets: [
        {
          name: "dev",
          accountId: "222222222222",
          region: "us-east-1",
          spokeCidr: "10.1.0.0/16",
        },
        {
          name: "prod",
          accountId: "333333333333",
          region: "us-east-1",
          requiresManualApproval: true,
          spokeCidr: "10.2.0.0/16",
        },
      ],
    },
  ],
};

const expectedInfraAppConfigResources = [
  "appconfig:us-east-1:111111111111:application/*",
  "appconfig:us-east-1:111111111111:application/*/environment/*",
  "appconfig:us-east-1:111111111111:application/*/environment/*/deployment/*",
];

function getPipelineResource(stack: cdk.Stack): PipelineResource {
  const template = Template.fromStack(stack);
  const resources = template.findResources("AWS::CodePipeline::Pipeline");
  return Object.values(resources)[0] as PipelineResource;
}

interface IamStatement {
  Action?: string | string[];
  Effect?: string;
  Resource?: unknown;
}

interface IamPolicy {
  Type: string;
  Properties?: {
    PolicyDocument?: {
      Statement?: IamStatement[];
    };
    Roles?: Array<{ Ref?: string }>;
  };
}

function getIamPolicyStatements(stack: cdk.Stack): IamStatement[] {
  const template = Template.fromStack(stack).toJSON() as {
    Resources: Record<string, IamPolicy>;
  };

  return Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy")
    .flatMap(
      (resource) => resource.Properties?.PolicyDocument?.Statement ?? [],
    );
}

function findStatementsForRolePattern(
  stack: cdk.Stack,
  roleIdPattern: RegExp,
): IamStatement[] {
  const template = Template.fromStack(stack).toJSON() as {
    Resources: Record<string, IamPolicy>;
  };

  return Object.values(template.Resources)
    .filter(
      (resource) =>
        resource.Type === "AWS::IAM::Policy" &&
        (resource.Properties?.Roles ?? []).some(
          (role) => role.Ref && roleIdPattern.test(role.Ref),
        ),
    )
    .flatMap(
      (resource) => resource.Properties?.PolicyDocument?.Statement ?? [],
    );
}

function statementHasActions(
  statement: IamStatement,
  actions: string[],
): boolean {
  const actualActions = Array.isArray(statement.Action)
    ? statement.Action
    : statement.Action
      ? [statement.Action]
      : [];

  return actions.every((action) => actualActions.includes(action));
}

test("infra pipeline has Security stage when security config is set", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "TestInfraPipeline", {
    config: securityConfig,
    env: {
      account: securityConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const stageNames = pipeline.Properties.Stages.map((stage) => stage.Name);
  assert.ok(
    stageNames.includes("Security"),
    "Security stage should be present",
  );
  assert.ok(!stageNames.includes("dev"), "Should not have dev workload stage");
  assert.ok(
    !stageNames.includes("prod"),
    "Should not have prod workload stage",
  );
});

test("infra pipeline has SharedServices stage when network is set (no domain)", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "NetworkOnlyInfra", {
    config: networkConfig,
    env: {
      account: networkConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const stageNames = pipeline.Properties.Stages.map((stage) => stage.Name);
  assert.ok(
    stageNames.includes("SharedServices"),
    "SharedServices stage should be present with network-only config",
  );
});

test("infra pipeline has no SharedServices stage when neither domain nor network is set", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "MinimalInfra", {
    config: testConfig,
    env: {
      account: testConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const stageNames = pipeline.Properties.Stages.map((stage) => stage.Name);
  assert.ok(
    !stageNames.includes("SharedServices"),
    "SharedServices stage should not be present without domain or network",
  );
});

test("infra pipeline always wires source and explicit V2 trigger", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "ExplicitTriggerInfra", {
    config: testConfig,
    env: {
      account: testConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const sourceAction = pipeline.Properties.Stages[0].Actions[0];
  assert.equal(sourceAction.ActionTypeId.Provider, "CodeStarSourceConnection");
  assert.equal(
    sourceAction.Configuration.ConnectionArn,
    testConfig.infraPipeline.connectionArn,
  );
  assert.equal(sourceAction.Configuration.DetectChanges, false);
  assert.equal(sourceAction.Configuration.OutputArtifactFormat, "CODE_ZIP");

  const trigger = pipeline.Properties.Triggers?.[0];
  assert.ok(trigger, "Expected V2 trigger");
  assert.equal(trigger.ProviderType, "CodeStarSourceConnection");
  assert.equal(
    trigger.GitConfiguration.SourceActionName,
    sourceAction.Name,
    "Trigger must be linked to source action",
  );
  assert.deepEqual(trigger.GitConfiguration.Push[0].Branches?.Includes, [
    testConfig.infraPipeline.repositoryBranch,
  ]);
  assert.equal(trigger.GitConfiguration.Push[0].FilePaths, undefined);
});

test("infra pipeline applies path filters to explicit V2 trigger when configured", () => {
  const triggerConfig: BootstrapConfig = {
    ...testConfig,
    infraPipeline: {
      ...testConfig.infraPipeline,
      triggerOnPaths: {
        filePathsIncludes: ["lib/infra/**"],
        filePathsExcludes: ["packages/**"],
      },
    },
  };

  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "PathTriggerInfra", {
    config: triggerConfig,
    env: {
      account: triggerConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const push = pipeline.Properties.Triggers?.[0]?.GitConfiguration.Push[0];
  assert.deepEqual(push?.Branches?.Includes, [
    triggerConfig.infraPipeline.repositoryBranch,
  ]);
  assert.deepEqual(push?.FilePaths?.Includes, ["lib/infra/**"]);
  assert.deepEqual(push?.FilePaths?.Excludes, ["packages/**"]);
});

test("infra pipeline source action role allows UseConnection on configured codeconnections ARN", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "InfraUseConnectionPolicy", {
    config: testConfig,
    env: {
      account: testConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const statements = findStatementsForRolePattern(
    stack,
    /Source.*CodePipelineActionRole/,
  );
  const useConnectionStatement = statements.find((s) =>
    statementHasActions(s, [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]),
  );
  assert.ok(
    useConnectionStatement,
    "Expected UseConnection policy on source action role",
  );
  assert.equal(useConnectionStatement.Effect, "Allow");
});

test("infra pipeline source action role allows UseConnection on configured codestar-connections ARN", () => {
  const app = new cdk.App();
  const codestarConfig: BootstrapConfig = {
    ...testConfig,
    infraPipeline: {
      ...testConfig.infraPipeline,
      connectionArn:
        "arn:aws:codestar-connections:us-east-1:111111111111:connection/test-id",
    },
  };
  const stack = new InfraPipelineStack(
    app,
    "InfraUseConnectionPolicyCodestar",
    {
      config: codestarConfig,
      env: {
        account: codestarConfig.sharedServicesAccountId,
        region: "us-east-1",
      },
    },
  );

  const statements = findStatementsForRolePattern(
    stack,
    /Source.*CodePipelineActionRole/,
  );
  const useConnectionStatement = statements.find((s) =>
    statementHasActions(s, [
      "codestar-connections:UseConnection",
      "codeconnections:UseConnection",
    ]),
  );
  assert.ok(
    useConnectionStatement,
    "Expected UseConnection policy on source action role",
  );
  assert.equal(useConnectionStatement.Effect, "Allow");
});

test("infra pipeline role trust policy allows codepipeline.amazonaws.com", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "InfraRoleTrustPolicy", {
    config: testConfig,
    env: {
      account: testConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
            Service: "codepipeline.amazonaws.com",
          },
        }),
      ]),
    },
  });
});

test("infra pipeline role allows scoped AppConfig deployment actions", () => {
  const app = new cdk.App();
  const stack = new InfraPipelineStack(app, "InfraAppConfigPolicy", {
    config: testConfig,
    env: {
      account: testConfig.sharedServicesAccountId,
      region: "us-east-1",
    },
  });

  const statements = getIamPolicyStatements(stack);
  const statement = statements.find((candidate) =>
    statementHasActions(candidate, [
      "appconfig:StartDeployment",
      "appconfig:GetDeployment",
      "appconfig:StopDeployment",
    ]),
  );
  assert.ok(statement, "Expected AppConfig deployment statement to exist");
  assert.equal(statement.Effect, "Allow");
  const renderedResource = JSON.stringify(statement.Resource);
  for (const expectedResource of expectedInfraAppConfigResources) {
    assert.ok(
      renderedResource.includes(expectedResource),
      `Expected AppConfig resource to include "${expectedResource}"`,
    );
  }
});

test("infra pipeline rejects connection ARN account mismatch with stack env", () => {
  const app = new cdk.App();
  const mismatchConfig: BootstrapConfig = {
    ...testConfig,
    infraPipeline: {
      ...testConfig.infraPipeline,
      connectionArn:
        "arn:aws:codeconnections:us-east-1:999999999999:connection/test-id",
    },
  };

  assert.throws(
    () =>
      new InfraPipelineStack(app, "InfraArnAccountMismatch", {
        config: mismatchConfig,
        env: {
          account: testConfig.sharedServicesAccountId,
          region: "us-east-1",
        },
      }),
    /must match stack account/,
  );
});

test("infra pipeline rejects connection ARN region mismatch with stack env", () => {
  const app = new cdk.App();
  const mismatchConfig: BootstrapConfig = {
    ...testConfig,
    infraPipeline: {
      ...testConfig.infraPipeline,
      connectionArn:
        "arn:aws:codeconnections:us-west-2:111111111111:connection/test-id",
    },
  };

  assert.throws(
    () =>
      new InfraPipelineStack(app, "InfraArnRegionMismatch", {
        config: mismatchConfig,
        env: {
          account: testConfig.sharedServicesAccountId,
          region: "us-east-1",
        },
      }),
    /must match stack region/,
  );
});
