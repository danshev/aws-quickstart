import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/defaults";
import { mergeBootstrapConfig, validateConfig } from "../config/load-config";
import type { BootstrapConfig } from "../config/schema";

const VALID_CONNECTION_ARN =
  "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id";

const testPipeline = {
  name: "TestPipeline",
  connectionArn: VALID_CONNECTION_ARN,
  owner: "test-owner",
  repositoryName: "test-repo",
  repositoryBranch: "main",
  crossAccountKeys: true,
};

const testApp = {
  name: "testapp",
  pipeline: testPipeline,
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

const validDefaultConfig: BootstrapConfig = mergeBootstrapConfig(
  defaultConfig,
  {
    infraPipeline: {
      ...defaultConfig.infraPipeline,
      connectionArn: VALID_CONNECTION_ARN,
    },
    apps: [testApp],
  },
);

test("rejects non-12-digit account IDs", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    sharedServicesAccountId: "12345",
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Invalid sharedServicesAccountId/,
  );
});

test("rejects empty deployment target region", () => {
  const [firstTarget, ...rest] = testApp.deploymentTargets;
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [
      {
        ...testApp,
        deploymentTargets: [{ ...firstTarget, region: " " }, ...rest],
      },
    ],
  });

  assert.throws(() => validateConfig(invalidConfig), /Region cannot be empty/);
});

test("allows apps with zero deployment targets during initial bootstrap", () => {
  const validConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [
      {
        ...testApp,
        deploymentTargets: [],
      },
    ],
  });

  assert.doesNotThrow(() => validateConfig(validConfig));
});

test("rejects duplicate deployment target names within an app", () => {
  const [firstTarget, secondTarget] = testApp.deploymentTargets;
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [
      {
        ...testApp,
        deploymentTargets: [
          { ...firstTarget, name: "dev" },
          { ...secondTarget, name: "dev" },
        ],
      },
    ],
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Duplicate deployment target name/,
  );
});

test("rejects invalid CIDR in network config", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    network: {
      egressVpcCidr: "not-a-cidr",
    },
  });

  assert.throws(() => validateConfig(invalidConfig), /Invalid egressVpcCidr/);
});

test("rejects missing spokeCidr for deployment target when network is enabled", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    network: {
      egressVpcCidr: "10.0.0.0/16",
    },
    apps: [
      {
        ...testApp,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "541405370622",
            region: "us-east-1",
            spokeCidr: "10.1.0.0/16",
          },
          {
            name: "prod",
            accountId: "090328751686",
            region: "us-east-1",
            requiresManualApproval: true,
          },
        ],
      },
    ],
  });

  assert.throws(() => validateConfig(invalidConfig), /Missing spokeCidr/);
});

test("rejects overlapping CIDRs in network config", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    network: {
      egressVpcCidr: "10.0.0.0/8",
    },
    apps: [
      {
        ...testApp,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "541405370622",
            region: "us-east-1",
            spokeCidr: "10.1.0.0/16",
          },
          {
            name: "prod",
            accountId: "090328751686",
            region: "us-east-1",
            requiresManualApproval: true,
            spokeCidr: "10.2.0.0/16",
          },
        ],
      },
    ],
  });

  assert.throws(() => validateConfig(invalidConfig), /Overlapping CIDRs/);
});

test("rejects empty apps array", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [],
  });

  assert.throws(() => validateConfig(invalidConfig), /At least one app/);
});

test("rejects duplicate app names", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [
      {
        name: "reboot",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "111111111111",
            region: "us-east-1",
          },
        ],
      },
      {
        name: "reboot",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "222222222222",
            region: "us-east-1",
          },
        ],
      },
    ],
  });

  assert.throws(() => validateConfig(invalidConfig), /Duplicate app name/);
});

test("rejects duplicate account IDs across apps", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    apps: [
      {
        name: "reboot",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "111111111111",
            region: "us-east-1",
          },
        ],
      },
      {
        name: "app2",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "111111111111",
            region: "us-east-1",
          },
        ],
      },
    ],
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Duplicate accountId.*across apps/,
  );
});

test("rejects empty connectionArn", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      connectionArn: "",
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /connectionArn cannot be empty/,
  );
});

test("rejects placeholder connectionArn", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      connectionArn:
        "arn:aws:codeconnections:us-east-1:111111111111:connection/placeholder",
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Placeholder connection IDs are not allowed/,
  );
});

test("rejects malformed connectionArn", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      connectionArn: "not-an-arn",
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Expected an ARN like "arn:aws:codeconnections/,
  );
});

test("rejects non-connection ARN resource", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:host/test",
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /Expected an ARN like "arn:aws:codeconnections/,
  );
});

test("rejects empty owner", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      owner: " ",
    },
  });

  assert.throws(() => validateConfig(invalidConfig), /owner cannot be empty/);
});

test("rejects triggerOnPaths with more than 8 filePathsIncludes", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      triggerOnPaths: {
        filePathsIncludes: [
          "a/**",
          "b/**",
          "c/**",
          "d/**",
          "e/**",
          "f/**",
          "g/**",
          "h/**",
          "i/**",
        ],
      },
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /filePathsIncludes exceeds the maximum of 8/,
  );
});

test("rejects triggerOnPaths with more than 8 filePathsExcludes", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    infraPipeline: {
      ...validDefaultConfig.infraPipeline,
      triggerOnPaths: {
        filePathsExcludes: [
          "a/**",
          "b/**",
          "c/**",
          "d/**",
          "e/**",
          "f/**",
          "g/**",
          "h/**",
          "i/**",
        ],
      },
    },
  });

  assert.throws(
    () => validateConfig(invalidConfig),
    /filePathsExcludes exceeds the maximum of 8/,
  );
});

test("validates spokeCidr overlap across targets from different apps", () => {
  const invalidConfig = mergeBootstrapConfig(validDefaultConfig, {
    network: {
      egressVpcCidr: "10.0.0.0/16",
    },
    apps: [
      {
        name: "reboot",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "111111111111",
            region: "us-east-1",
            spokeCidr: "10.1.0.0/16",
          },
        ],
      },
      {
        name: "app2",
        pipeline: testPipeline,
        deploymentTargets: [
          {
            name: "dev",
            accountId: "222222222222",
            region: "us-east-1",
            spokeCidr: "10.1.0.0/16",
          },
        ],
      },
    ],
  });

  assert.throws(() => validateConfig(invalidConfig), /Overlapping CIDRs/);
});
