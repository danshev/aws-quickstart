import type { BootstrapConfig } from "./schema";

export const localConfig: Partial<BootstrapConfig> = {
  sharedServicesAccountId: "123456789012",
  apps: [
    {
      name: "myapp",
      domain: {
        rootDomain: "myapp.com",
        delegationRoleName: "Route53DelegationRole",
      },
      pipeline: {
        name: "MyappPipeline",
        connectionArn:
          "arn:aws:codeconnections:us-east-1:123456789012:connection/your-id",
        owner: "your-github-user",
        repositoryName: "your-repo",
        repositoryBranch: "main",
        crossAccountKeys: true,
        triggerOnPaths: {
          filePathsIncludes: [
            "lib/myapp/**",
            "packages/myapp/**",
            "lib/constructs/**",
            "lib/infra/spoke-network-stack.ts",
            "lib/pipeline/app-pipeline-stack.ts",
            "lib/app-stage-props.ts",
            "bin/app.ts",
            "config/**",
          ],
        },
      },
      deploymentTargets: [
        {
          name: "dev",
          accountId: "210987654321",
          region: "us-east-1",
        },
        {
          name: "prod",
          accountId: "345678901234",
          region: "us-east-1",
          requiresManualApproval: true,
        },
      ],
    },
  ],
  infraPipeline: {
    name: "InfraDeployPipeline",
    connectionArn:
      "arn:aws:codeconnections:us-east-1:123456789012:connection/your-id",
    owner: "your-github-user",
    repositoryName: "your-repo",
    repositoryBranch: "main",
    crossAccountKeys: true,
  },
};
