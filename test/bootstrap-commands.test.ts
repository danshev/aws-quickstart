import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/defaults";
import type { BootstrapConfig } from "../config/schema";
import { generateBootstrapCommands } from "../scripts/bootstrap/print-bootstrap-commands";

const testConfig: BootstrapConfig = {
  ...defaultConfig,
  apps: [
    {
      name: "testapp",
      pipeline: {
        name: "TestPipeline",
        connectionArn:
          "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
        owner: "test-owner",
        repositoryName: "test-repo",
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
      ],
    },
  ],
};

test("bootstrap command generation includes shared-services trust", () => {
  const lines = generateBootstrapCommands(testConfig);
  const output = lines.join("\n");

  const allTargets = testConfig.apps.flatMap((app) => app.deploymentTargets);

  const commandCount = lines.filter((line) =>
    line.startsWith("cdk bootstrap aws://"),
  ).length;
  const uniqueRegionCount = new Set(allTargets.map((target) => target.region))
    .size;

  // Total commands = shared-services (per unique region) + workload targets + security targets (deduped)
  const workloadAccountIds = new Set(
    allTargets.map((t) => `${t.accountId}:${t.region}`),
  );
  const dedupedSecurityCount = testConfig.security
    ? [
        testConfig.security.logArchiveAccountId,
        testConfig.security.auditAccountId,
      ].filter(
        (id) =>
          !workloadAccountIds.has(
            `${id}:${allTargets[0]?.region ?? "us-east-1"}`,
          ),
      ).length
    : 0;

  assert.equal(
    commandCount,
    uniqueRegionCount + allTargets.length + dedupedSecurityCount,
  );
  assert.match(
    output,
    new RegExp(`--trust ${testConfig.sharedServicesAccountId}`),
  );
});

test("bootstrap command generation includes security accounts and dedupes by account+region", () => {
  const sharedRegion = "us-east-1";
  const duplicatedSecurityAccountId = "222222222222";
  const auditAccountId = "999999999999";

  const configWithSecurity: BootstrapConfig = {
    ...testConfig,
    security: {
      logArchiveAccountId: duplicatedSecurityAccountId,
      auditAccountId,
    },
  };

  const lines = generateBootstrapCommands(configWithSecurity);
  const output = lines.join("\n");
  const commandLines = lines.filter((line) =>
    line.startsWith("cdk bootstrap aws://"),
  );

  const workloadTargets = configWithSecurity.apps.flatMap(
    (app) => app.deploymentTargets,
  );
  const uniqueRegions = new Set(workloadTargets.map((target) => target.region));
  const security = configWithSecurity.security;
  assert.ok(security, "security config should be defined");
  const uniqueTrustTargets = new Set([
    ...workloadTargets.map((target) => `${target.accountId}:${target.region}`),
    `${security.logArchiveAccountId}:${sharedRegion}`,
    `${security.auditAccountId}:${sharedRegion}`,
  ]);

  assert.equal(
    commandLines.length,
    uniqueRegions.size + uniqueTrustTargets.size,
  );
  assert.match(
    output,
    new RegExp(`cdk bootstrap aws://${auditAccountId}/${sharedRegion}`),
  );
  assert.equal(
    output.match(
      new RegExp(
        `cdk bootstrap aws://${duplicatedSecurityAccountId}/${sharedRegion}`,
        "g",
      ),
    )?.length ?? 0,
    1,
  );
});
