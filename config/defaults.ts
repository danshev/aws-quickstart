import type { BootstrapConfig } from "./schema";

export const defaultConfig: BootstrapConfig = {
  sharedServicesAccountId: "123456789012",
  infraPipeline: {
    name: "InfraDeployPipeline",
    connectionArn:
      "arn:aws:codeconnections:us-east-1:123456789012:connection/your-connection-id",
    owner: "my-github-user",
    repositoryName: "my-repo",
    repositoryBranch: "main",
    crossAccountKeys: true,
    triggerOnPaths: {
      filePathsExcludes: ["packages/**"],
    },
  },
  security: {
    logArchiveAccountId: "234567890123",
    auditAccountId: "345678901234",
  },
  apps: [],
};
