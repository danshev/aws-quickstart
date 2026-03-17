import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config/schema";
import { AppPipelineStack } from "../lib/pipeline/app-pipeline-stack";

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

const testAppConfig: AppConfig = {
  name: "testapp",
  pipeline: {
    name: "TestappTestPipeline",
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
      requiresManualApproval: false,
    },
    {
      name: "prod",
      accountId: "333333333333",
      region: "us-east-1",
      requiresManualApproval: true,
    },
  ],
};

const expectedAppConfigResources = [
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

test("app pipeline stages are generated from config and manual approval is conditional", () => {
  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "TestRebootPipeline", {
    appConfig: testAppConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const stageNames = pipeline.Properties.Stages.map((stage) => stage.Name);
  assert.ok(stageNames.includes("dev"));
  assert.ok(stageNames.includes("prod"));
  assert.ok(stageNames.indexOf("dev") < stageNames.indexOf("prod"));

  assert.ok(
    !stageNames.includes("Security"),
    "App pipeline should not have Security stage",
  );
  assert.ok(
    !stageNames.includes("SharedServices"),
    "App pipeline should not have SharedServices stage",
  );

  const approvalActions = pipeline.Properties.Stages.flatMap(
    (stage) => stage.Actions,
  ).filter((action) => action.ActionTypeId.Category === "Approval");
  assert.equal(approvalActions.length, 1);
});

test("app pipeline works without manual approval", () => {
  const noApprovalConfig: AppConfig = {
    ...testAppConfig,
    deploymentTargets: [
      {
        name: "dev",
        accountId: "222222222222",
        region: "us-east-1",
        requiresManualApproval: false,
      },
    ],
  };

  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "NoApprovalPipeline", {
    appConfig: noApprovalConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const approvalActions = pipeline.Properties.Stages.flatMap(
    (stage) => stage.Actions,
  ).filter((action) => action.ActionTypeId.Category === "Approval");
  assert.equal(approvalActions.length, 0);
});

test("app pipeline always wires source and explicit V2 trigger", () => {
  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "AppExplicitTrigger", {
    appConfig: testAppConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const sourceAction = pipeline.Properties.Stages[0].Actions[0];
  assert.equal(sourceAction.ActionTypeId.Provider, "CodeStarSourceConnection");
  assert.equal(
    sourceAction.Configuration.ConnectionArn,
    testAppConfig.pipeline.connectionArn,
  );
  assert.equal(sourceAction.Configuration.DetectChanges, false);
  assert.equal(sourceAction.Configuration.OutputArtifactFormat, "CODE_ZIP");

  const trigger = pipeline.Properties.Triggers?.[0];
  assert.ok(trigger, "Expected V2 trigger");
  assert.equal(trigger.ProviderType, "CodeStarSourceConnection");
  assert.equal(trigger.GitConfiguration.SourceActionName, sourceAction.Name);
  assert.deepEqual(trigger.GitConfiguration.Push[0].Branches?.Includes, [
    testAppConfig.pipeline.repositoryBranch,
  ]);
  assert.equal(trigger.GitConfiguration.Push[0].FilePaths, undefined);
});

test("app pipeline applies path filters to explicit V2 trigger when configured", () => {
  const triggerConfig: AppConfig = {
    ...testAppConfig,
    pipeline: {
      ...testAppConfig.pipeline,
      triggerOnPaths: {
        filePathsIncludes: ["lib/testapp/**"],
        filePathsExcludes: ["packages/**"],
      },
    },
  };

  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "AppPathTrigger", {
    appConfig: triggerConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
      region: "us-east-1",
    },
  });

  const pipeline = getPipelineResource(stack);
  const push = pipeline.Properties.Triggers?.[0]?.GitConfiguration.Push[0];
  assert.deepEqual(push?.Branches?.Includes, [
    triggerConfig.pipeline.repositoryBranch,
  ]);
  assert.deepEqual(push?.FilePaths?.Includes, ["lib/testapp/**"]);
  assert.deepEqual(push?.FilePaths?.Excludes, ["packages/**"]);
});

test("app pipeline source action role allows UseConnection on configured codeconnections ARN", () => {
  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "AppUseConnectionPolicy", {
    appConfig: testAppConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
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

test("app pipeline source action role allows UseConnection on configured codestar-connections ARN", () => {
  const app = new cdk.App();
  const codestarConfig: AppConfig = {
    ...testAppConfig,
    pipeline: {
      ...testAppConfig.pipeline,
      connectionArn:
        "arn:aws:codestar-connections:us-east-1:111111111111:connection/test-id",
    },
  };
  const stack = new AppPipelineStack(app, "AppUseConnectionPolicyCodestar", {
    appConfig: codestarConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
      region: "us-east-1",
    },
  });

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

test("app pipeline role trust policy allows codepipeline.amazonaws.com", () => {
  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "AppRoleTrustPolicy", {
    appConfig: testAppConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
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

test("app pipeline role allows scoped AppConfig deployment actions", () => {
  const app = new cdk.App();
  const stack = new AppPipelineStack(app, "AppAppConfigPolicy", {
    appConfig: testAppConfig,
    sharedServicesAccountId: "111111111111",
    env: {
      account: "111111111111",
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
  for (const expectedResource of expectedAppConfigResources) {
    assert.ok(
      renderedResource.includes(expectedResource),
      `Expected AppConfig resource to include "${expectedResource}"`,
    );
  }
});

test("app pipeline rejects connection ARN account mismatch with stack env", () => {
  const app = new cdk.App();
  const mismatchConfig: AppConfig = {
    ...testAppConfig,
    pipeline: {
      ...testAppConfig.pipeline,
      connectionArn:
        "arn:aws:codeconnections:us-east-1:999999999999:connection/test-id",
    },
  };

  assert.throws(
    () =>
      new AppPipelineStack(app, "AppArnAccountMismatch", {
        appConfig: mismatchConfig,
        sharedServicesAccountId: "111111111111",
        env: {
          account: "111111111111",
          region: "us-east-1",
        },
      }),
    /must match stack account/,
  );
});

test("app pipeline rejects connection ARN region mismatch with stack env", () => {
  const app = new cdk.App();
  const mismatchConfig: AppConfig = {
    ...testAppConfig,
    pipeline: {
      ...testAppConfig.pipeline,
      connectionArn:
        "arn:aws:codeconnections:us-west-2:111111111111:connection/test-id",
    },
  };

  assert.throws(
    () =>
      new AppPipelineStack(app, "AppArnRegionMismatch", {
        appConfig: mismatchConfig,
        sharedServicesAccountId: "111111111111",
        env: {
          account: "111111111111",
          region: "us-east-1",
        },
      }),
    /must match stack region/,
  );
});
