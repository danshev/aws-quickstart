import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBootstrapPlan,
  deriveExistingAccountNames,
  getSkippedTrustTargetNames,
  resolveExistingAccountNamesFromState,
} from "../scripts/org/bootstrap-cdk";
import type { OrgConfig } from "../scripts/org/types";

const baseConfig: OrgConfig = {
  region: "us-east-1",
  identity: {
    userName: "test",
    givenName: "Test",
    familyName: "User",
    groupName: "Admins",
    groupDescription: "desc",
    permissionSetName: "AdministratorAccess",
    sessionDuration: "PT8H",
  },
  crossAccountRoleName: "OrganizationAccountAccessRole",
  accounts: [
    {
      name: "Shared Services",
      ouPath: ["Infrastructure"],
      role: "sharedServices",
    },
    {
      name: "App 1 (dev)",
      ouPath: ["Workloads", "Dev"],
      app: "reboot",
      stage: "dev",
    },
    { name: "Audit", ouPath: ["Security"], role: "audit" },
  ],
  ous: [["Infrastructure"], ["Workloads"], ["Workloads", "Dev"], ["Security"]],
  infraPipeline: {
    name: "InfraDeployPipeline",
    connectionArn:
      "arn:aws:codeconnections:us-east-1:111111111111:connection/test",
    owner: "owner",
    repositoryName: "repo",
    repositoryBranch: "main",
    crossAccountKeys: true,
  },
  apps: [
    {
      name: "reboot",
      pipeline: {
        name: "RebootPipeline",
        connectionArn:
          "arn:aws:codeconnections:us-east-1:111111111111:connection/test",
        owner: "owner",
        repositoryName: "repo",
        repositoryBranch: "main",
        crossAccountKeys: true,
      },
    },
  ],
};

test("skip mode filters only existing accounts", () => {
  const plan = buildBootstrapPlan(
    baseConfig,
    { skipExistingAccounts: true },
    {
      buildTargetsFn: () => ({
        sharedServices: {
          name: "Shared Services",
          accountId: "111111111111",
          region: "us-east-1",
          trustSharedServices: false,
        },
        others: [
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
          {
            name: "Audit",
            accountId: "333333333333",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
        all: [
          {
            name: "Shared Services",
            accountId: "111111111111",
            region: "us-east-1",
            trustSharedServices: false,
          },
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
          {
            name: "Audit",
            accountId: "333333333333",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
      }),
      resolveExistingAccountNamesFn: () => new Set(["App 1 (dev)"]),
    },
  );

  assert.deepEqual(plan.skippedNames, ["App 1 (dev)"]);
  assert.deepEqual(
    plan.targetsToBootstrap.map((t) => t.name),
    ["Shared Services", "Audit"],
  );
});

test("skip mode can skip shared services without crashing plan generation", () => {
  const plan = buildBootstrapPlan(
    baseConfig,
    { skipExistingAccounts: true },
    {
      buildTargetsFn: () => ({
        sharedServices: {
          name: "Shared Services",
          accountId: "111111111111",
          region: "us-east-1",
          trustSharedServices: false,
        },
        others: [
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
        all: [
          {
            name: "Shared Services",
            accountId: "111111111111",
            region: "us-east-1",
            trustSharedServices: false,
          },
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
      }),
      resolveExistingAccountNamesFn: () => new Set(["Shared Services"]),
    },
  );

  assert.deepEqual(plan.skippedNames, ["Shared Services"]);
  assert.deepEqual(
    plan.targetsToBootstrap.map((t) => t.name),
    ["App 1 (dev)"],
  );
});

test("skip mode fails fast when existing-account state cannot be read", () => {
  assert.throws(
    () =>
      resolveExistingAccountNamesFromState(() => {
        throw new Error(".org-state.json not found");
      }),
    /Run `npm run org:build`/,
  );
});

test("default mode remains unchanged and includes all accounts", () => {
  const plan = buildBootstrapPlan(
    baseConfig,
    {},
    {
      buildTargetsFn: () => ({
        sharedServices: {
          name: "Shared Services",
          accountId: "111111111111",
          region: "us-east-1",
          trustSharedServices: false,
        },
        others: [
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
        all: [
          {
            name: "Shared Services",
            accountId: "111111111111",
            region: "us-east-1",
            trustSharedServices: false,
          },
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
      }),
      resolveExistingAccountNamesFn: () =>
        new Set(["Shared Services", "App 1 (dev)"]),
    },
  );

  assert.deepEqual(plan.skippedNames, []);
  assert.deepEqual(
    plan.targetsToBootstrap.map((t) => t.name),
    ["Shared Services", "App 1 (dev)"],
  );
});

test("skip mode reports skipped trust-required targets", () => {
  const plan = buildBootstrapPlan(
    baseConfig,
    { skipExistingAccounts: true },
    {
      buildTargetsFn: () => ({
        sharedServices: {
          name: "Shared Services",
          accountId: "111111111111",
          region: "us-east-1",
          trustSharedServices: false,
        },
        others: [
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
          {
            name: "Audit",
            accountId: "333333333333",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
        all: [
          {
            name: "Shared Services",
            accountId: "111111111111",
            region: "us-east-1",
            trustSharedServices: false,
          },
          {
            name: "App 1 (dev)",
            accountId: "222222222222",
            region: "us-east-1",
            trustSharedServices: true,
          },
          {
            name: "Audit",
            accountId: "333333333333",
            region: "us-east-1",
            trustSharedServices: true,
          },
        ],
      }),
      resolveExistingAccountNamesFn: () =>
        new Set(["Shared Services", "Audit"]),
    },
  );

  assert.deepEqual(getSkippedTrustTargetNames(plan), ["Audit"]);
});

test("backward compatibility: requestId existing:* is treated as existing", () => {
  const names = deriveExistingAccountNames([
    {
      requestId: "existing:111111111111",
      accountName: "Shared Services",
      targetOuPath: ["Infrastructure"],
    },
    {
      requestId: "car-abc123",
      accountName: "App 1 (dev)",
      targetOuPath: ["Workloads", "Dev"],
      existingAccount: true,
    },
    {
      requestId: "car-def456",
      accountName: "Audit",
      targetOuPath: ["Security"],
      existingAccount: false,
    },
  ]);

  assert.deepEqual(Array.from(names).sort(), [
    "App 1 (dev)",
    "Shared Services",
  ]);
});
