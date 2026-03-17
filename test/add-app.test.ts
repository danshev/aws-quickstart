import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  addAppToYaml,
  deriveDisplayName,
  discoverStages,
  generateAppResourcesTemplate,
  generateAppStageTemplate,
  scaffoldAppDirectory,
  toPascalCase,
} from "../scripts/org/add-app";
import { parseOrgConfig } from "../scripts/org/parse-org-config";

// ---------------------------------------------------------------------------
// deriveDisplayName
// ---------------------------------------------------------------------------

test("deriveDisplayName converts identifiers to display names", () => {
  assert.equal(deriveDisplayName("app2"), "App 2");
  assert.equal(deriveDisplayName("my-api"), "My Api");
  assert.equal(deriveDisplayName("hello_world"), "Hello World");
  assert.equal(deriveDisplayName("app"), "App");
});

// ---------------------------------------------------------------------------
// toPascalCase
// ---------------------------------------------------------------------------

test("toPascalCase converts identifiers to PascalCase", () => {
  assert.equal(toPascalCase("app2"), "App2");
  assert.equal(toPascalCase("my-api"), "MyApi");
  assert.equal(toPascalCase("hello_world"), "HelloWorld");
  assert.equal(toPascalCase("app"), "App");
});

// ---------------------------------------------------------------------------
// discoverStages
// ---------------------------------------------------------------------------

test("discoverStages finds stages from real org-config.yaml", () => {
  const configPath = path.resolve("scripts", "org", "org-config.yaml");
  const config = parseOrgConfig(configPath);
  const stages = discoverStages(config);

  assert.equal(
    stages.length,
    0,
    "Template org-config should have no workload stages by default",
  );
});

// ---------------------------------------------------------------------------
// addAppToYaml — end-to-end YAML round-trip
// ---------------------------------------------------------------------------

test("addAppToYaml adds accounts and app entry to YAML", () => {
  const inputYaml = `# Top-level comment
region: us-east-1

identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test admins
  permissionSetName: Admin
  sessionDuration: PT1H

crossAccountRoleName: OrganizationAccountAccessRole

# Organization tree
organization:
  Infrastructure:
    Shared Services:
      account: true
      role: sharedServices

  Workloads:
    Dev:
      App 1 (dev):
        account: true
        app: reboot
        stage: dev
        requiresManualApproval: false

    Prod:
      App 1 (prod):
        account: true
        app: reboot
        stage: prod
        requiresManualApproval: true

  Security:
    Log Archive:
      account: true
      role: logArchive
    Audit:
      account: true
      role: audit

infraPipeline:
  name: InfraDeployPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true

apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`;

  const stages = [
    {
      stage: "dev",
      ouPath: ["Workloads", "Dev"],
      requiresManualApproval: false,
    },
    {
      stage: "prod",
      ouPath: ["Workloads", "Prod"],
      requiresManualApproval: true,
    },
  ];

  const result = addAppToYaml(
    inputYaml,
    "app2",
    "App 2",
    "App2Pipeline",
    "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
    "test-owner",
    "MyNewRepo",
    "main",
    stages,
  );

  // Parse the result to verify structure
  const parsed = YAML.parse(result);

  // New accounts exist under correct OUs
  const devOu = parsed.organization.Workloads.Dev;
  assert.ok(devOu["App 2 (dev)"], "Should have App 2 (dev) account");
  assert.equal(devOu["App 2 (dev)"].account, true);
  assert.equal(devOu["App 2 (dev)"].app, "app2");
  assert.equal(devOu["App 2 (dev)"].stage, "dev");
  assert.equal(devOu["App 2 (dev)"].requiresManualApproval, false);

  const prodOu = parsed.organization.Workloads.Prod;
  assert.ok(prodOu["App 2 (prod)"], "Should have App 2 (prod) account");
  assert.equal(prodOu["App 2 (prod)"].account, true);
  assert.equal(prodOu["App 2 (prod)"].app, "app2");
  assert.equal(prodOu["App 2 (prod)"].stage, "prod");
  assert.equal(prodOu["App 2 (prod)"].requiresManualApproval, true);

  // New apps[] entry
  assert.equal(parsed.apps.length, 2);
  const newApp = parsed.apps.find((a: { name: string }) => a.name === "app2");
  assert.ok(newApp, "Should have app2 in apps array");
  assert.equal(newApp.pipeline.name, "App2Pipeline");
  assert.equal(
    newApp.pipeline.connectionArn,
    "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
  );
  assert.equal(newApp.pipeline.owner, "test-owner");
  assert.equal(newApp.pipeline.repositoryName, "MyNewRepo");
  assert.equal(newApp.pipeline.repositoryBranch, "main");
  assert.equal(newApp.pipeline.crossAccountKeys, true);

  // Existing entries unchanged
  assert.ok(devOu["App 1 (dev)"], "Original App 1 (dev) should still exist");
  assert.equal(devOu["App 1 (dev)"].app, "reboot");
  assert.ok(prodOu["App 1 (prod)"], "Original App 1 (prod) should still exist");
  assert.equal(prodOu["App 1 (prod)"].app, "reboot");
  assert.equal(parsed.apps[0].name, "reboot");

  // Comments preserved
  assert.ok(
    result.includes("# Top-level comment"),
    "Should preserve top-level comment",
  );
  assert.ok(
    result.includes("# Organization tree"),
    "Should preserve organization comment",
  );
});

test("addAppToYaml works with the real org-config.yaml", () => {
  const configPath = path.resolve("scripts", "org", "org-config.yaml");
  const yamlContent = fs.readFileSync(configPath, "utf-8");
  const config = parseOrgConfig(configPath);
  const stages = discoverStages(config);

  const result = addAppToYaml(
    yamlContent,
    "app2",
    "App 2",
    "App2Pipeline",
    config.infraPipeline.connectionArn,
    config.infraPipeline.owner,
    "MyNewRepo",
    "main",
    stages,
  );

  // Write to temp file and validate with parseOrgConfig
  const tmpFile = path.join(os.tmpdir(), "add-app-roundtrip-test.yaml");
  fs.writeFileSync(tmpFile, result, "utf-8");

  try {
    const updatedConfig = parseOrgConfig(tmpFile);

    // Template has no workload stages, so no new accounts are added
    assert.equal(updatedConfig.accounts.length, 3);

    // Should have 1 app (0 original + 1 new)
    assert.equal(updatedConfig.apps.length, 1);
    assert.equal(updatedConfig.apps[0].name, "app2");
    assert.equal(updatedConfig.apps[0].pipeline.name, "App2Pipeline");

    // Original comments should be preserved
    assert.ok(
      result.includes("# org-config.yaml"),
      "Should preserve file header comment",
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// addAppToYaml — triggerOnPaths
// ---------------------------------------------------------------------------

test("addAppToYaml sets triggerOnPaths.filePathsIncludes on new app", () => {
  const inputYaml = `region: us-east-1
organization:
  Workloads:
    Dev:
      App 1 (dev):
        account: true
        app: reboot
        stage: dev
        requiresManualApproval: false
infraPipeline:
  name: InfraPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`;

  const stages = [
    {
      stage: "dev",
      ouPath: ["Workloads", "Dev"],
      requiresManualApproval: false,
    },
  ];

  const result = addAppToYaml(
    inputYaml,
    "app2",
    "App 2",
    "App2Pipeline",
    "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
    "test-owner",
    "MyNewRepo",
    "main",
    stages,
  );

  const parsed = YAML.parse(result);
  const newApp = parsed.apps.find((a: { name: string }) => a.name === "app2");
  assert.ok(
    newApp.pipeline.triggerOnPaths,
    "New app should have triggerOnPaths",
  );
  assert.deepEqual(newApp.pipeline.triggerOnPaths.filePathsIncludes, [
    "lib/app2/**",
    "packages/app2/**",
  ]);
});

test("addAppToYaml appends to infraPipeline.triggerOnPaths.filePathsExcludes", () => {
  const inputYaml = `region: us-east-1
organization:
  Workloads:
    Dev:
      App 1 (dev):
        account: true
        app: reboot
        stage: dev
        requiresManualApproval: false
infraPipeline:
  name: InfraPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true
  triggerOnPaths:
    filePathsExcludes:
      - "lib/reboot/**"
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`;

  const stages = [
    {
      stage: "dev",
      ouPath: ["Workloads", "Dev"],
      requiresManualApproval: false,
    },
  ];

  const result = addAppToYaml(
    inputYaml,
    "app2",
    "App 2",
    "App2Pipeline",
    "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
    "test-owner",
    "MyNewRepo",
    "main",
    stages,
  );

  const parsed = YAML.parse(result);
  assert.deepEqual(parsed.infraPipeline.triggerOnPaths.filePathsExcludes, [
    "lib/reboot/**",
    "lib/app2/**",
  ]);
});

test("addAppToYaml creates infraPipeline.triggerOnPaths when missing", () => {
  const inputYaml = `region: us-east-1
organization:
  Workloads:
    Dev:
      App 1 (dev):
        account: true
        app: reboot
        stage: dev
        requiresManualApproval: false
infraPipeline:
  name: InfraPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`;

  const stages = [
    {
      stage: "dev",
      ouPath: ["Workloads", "Dev"],
      requiresManualApproval: false,
    },
  ];

  const result = addAppToYaml(
    inputYaml,
    "app2",
    "App 2",
    "App2Pipeline",
    "arn:aws:codeconnections:us-east-1:111111111111:connection/test-id",
    "test-owner",
    "MyNewRepo",
    "main",
    stages,
  );

  const parsed = YAML.parse(result);
  assert.ok(
    parsed.infraPipeline.triggerOnPaths,
    "Should create triggerOnPaths",
  );
  assert.deepEqual(parsed.infraPipeline.triggerOnPaths.filePathsExcludes, [
    "lib/app2/**",
  ]);
});

// ---------------------------------------------------------------------------
// scaffoldAppDirectory
// ---------------------------------------------------------------------------

test("scaffoldAppDirectory creates expected files with correct content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));

  try {
    const created = scaffoldAppDirectory("app2", tmpDir);
    assert.equal(created, true);

    const appStage = fs.readFileSync(
      path.join(tmpDir, "lib", "app2", "app-stage.ts"),
      "utf-8",
    );
    assert.ok(
      appStage.includes("class AppStage"),
      "Should contain AppStage class",
    );
    assert.ok(
      appStage.includes('from "../app-stage-props"'),
      "Should import from shared app-stage-props",
    );
    assert.ok(
      appStage.includes('from "../infra/spoke-network-stack"'),
      "Should import SpokeNetworkStack from infra",
    );
    assert.ok(
      appStage.includes("App2AppResources"),
      "Should use PascalCase app name in construct ID",
    );

    const appResources = fs.readFileSync(
      path.join(tmpDir, "lib", "app2", "stacks", "app-resources-stack.ts"),
      "utf-8",
    );
    assert.ok(
      appResources.includes("class AppResourcesStack"),
      "Should contain AppResourcesStack class",
    );
    assert.ok(
      appResources.includes("app2-media-"),
      "Should use app-aware bucket name",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("scaffoldAppDirectory skips when directory already exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-skip-"));

  try {
    // Pre-create the directory
    fs.mkdirSync(path.join(tmpDir, "lib", "app2"), { recursive: true });

    const created = scaffoldAppDirectory("app2", tmpDir);
    assert.equal(created, false);

    // Should not have created any files
    assert.equal(
      fs.existsSync(path.join(tmpDir, "lib", "app2", "app-stage.ts")),
      false,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// generateAppStageTemplate
// ---------------------------------------------------------------------------

test("generateAppStageTemplate produces string with key markers", () => {
  const template = generateAppStageTemplate("my-api");

  assert.ok(
    template.includes("class AppStage"),
    "Should define AppStage class",
  );
  assert.ok(
    template.includes('from "../app-stage-props"'),
    "Should import AppStageProps",
  );
  assert.ok(
    template.includes('from "../infra/spoke-network-stack"'),
    "Should import SpokeNetworkStack",
  );
  assert.ok(
    template.includes('from "./stacks/app-resources-stack"'),
    "Should import AppResourcesStack",
  );
  assert.ok(
    template.includes("MyApiAppResources"),
    "Should use PascalCase in construct ID",
  );
});

// ---------------------------------------------------------------------------
// generateAppResourcesTemplate
// ---------------------------------------------------------------------------

test("generateAppResourcesTemplate uses app-aware bucket name", () => {
  const template = generateAppResourcesTemplate("my-api");

  assert.ok(
    template.includes("class AppResourcesStack"),
    "Should define AppResourcesStack class",
  );
  assert.ok(
    template.includes("my-api-media-"),
    "Bucket name should include app name",
  );
  assert.ok(
    template.includes("interface DomainProps"),
    "Should export DomainProps interface",
  );
});
