import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
  getDeploymentTargetsByApp,
  parseOrgConfig,
} from "../scripts/org/parse-org-config";

test("parses the default org-config.yaml correctly", () => {
  const configPath = path.resolve("scripts", "org", "org-config.yaml");
  const config = parseOrgConfig(configPath);

  // Region
  assert.equal(config.region, "us-east-1");

  // Identity
  assert.equal(config.identity.userName, "jdoe");
  assert.equal(config.identity.givenName, "Jane");
  assert.equal(config.identity.familyName, "Doe");

  // OUs — should be parent-before-child order
  const ouKeys = config.ous.map((p) => p.join("/"));
  assert.ok(ouKeys.includes("Infrastructure"));
  assert.ok(ouKeys.includes("Workloads"));
  assert.ok(ouKeys.includes("Security"));

  // Accounts (Shared Services, Log Archive, Audit)
  assert.equal(config.accounts.length, 3);

  const sharedSvc = config.accounts.find((a) => a.role === "sharedServices");
  assert.ok(sharedSvc);
  assert.equal(sharedSvc.name, "Shared Services");
  assert.deepEqual(sharedSvc.ouPath, ["Infrastructure"]);

  const logArchive = config.accounts.find((a) => a.role === "logArchive");
  assert.ok(logArchive);
  assert.equal(logArchive.name, "Log Archive");
  assert.deepEqual(logArchive.ouPath, ["Security"]);

  const audit = config.accounts.find((a) => a.role === "audit");
  assert.ok(audit);
  assert.equal(audit.name, "Audit");
  assert.deepEqual(audit.ouPath, ["Security"]);

  // Infra Pipeline
  assert.equal(config.infraPipeline.name, "InfraDeployPipeline");
  assert.equal(config.infraPipeline.repositoryName, "my-repo");
  assert.equal(config.infraPipeline.owner, "my-github-user");

  // Apps (empty in template — users add apps via org:add-app)
  assert.equal(config.apps.length, 0);
});

test("getDeploymentTargetsByApp groups accounts correctly", () => {
  const configPath = path.resolve("scripts", "org", "org-config.yaml");
  const config = parseOrgConfig(configPath);
  const byApp = getDeploymentTargetsByApp(config);

  assert.equal(byApp.size, 0);
});

test("rejects account with stage but no app", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpFile = path.join(os.tmpdir(), "no-app-org-config.yaml");

  fs.writeFileSync(
    tmpFile,
    `
region: us-east-1
identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test
  permissionSetName: Admin
  sessionDuration: PT1H
organization:
  Infra:
    SharedSvc:
      account: true
      role: sharedServices
  Workloads:
    Dev:
      DevAccount:
        account: true
        stage: dev
infraPipeline:
  name: TestPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`,
    "utf-8",
  );

  assert.throws(() => parseOrgConfig(tmpFile), /has stage.*but no app/);

  fs.unlinkSync(tmpFile);
});

test("rejects config without a sharedServices account", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpFile = path.join(os.tmpdir(), "bad-org-config.yaml");

  fs.writeFileSync(
    tmpFile,
    `
region: us-east-1
identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test
  permissionSetName: Admin
  sessionDuration: PT1H
organization:
  SomeOU:
    SomeAccount:
      account: true
      app: reboot
      stage: dev
infraPipeline:
  name: TestPipeline
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
  owner: test-owner
  repositoryName: TestRepo
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
      owner: test-owner
      repositoryName: TestRepo
      repositoryBranch: main
      crossAccountKeys: true
`,
    "utf-8",
  );

  assert.throws(() => parseOrgConfig(tmpFile), /role: sharedServices/);

  fs.unlinkSync(tmpFile);
});

test("parses managementProfile and managementSetupRoleName when present", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpFile = path.join(os.tmpdir(), "mgmt-profile-org-config.yaml");

  fs.writeFileSync(
    tmpFile,
    `
region: us-east-1
identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test
  permissionSetName: Admin
  sessionDuration: PT1H
crossAccountRoleName: OrganizationAccountAccessRole
managementProfile: org-setup
managementSetupRoleName: OrgSetupRole
organization:
  Infra:
    SharedSvc:
      account: true
      role: sharedServices
infraPipeline:
  name: P
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
  owner: test-owner
  repositoryName: R
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
      owner: test-owner
      repositoryName: R
      repositoryBranch: main
      crossAccountKeys: true
`,
    "utf-8",
  );

  const config = parseOrgConfig(tmpFile);
  assert.equal(config.managementProfile, "org-setup");
  assert.equal(config.managementSetupRoleName, "OrgSetupRole");

  fs.unlinkSync(tmpFile);
});

test("managementProfile and managementSetupRoleName are present in default config", () => {
  const configPath = path.resolve("scripts", "org", "org-config.yaml");
  const config = parseOrgConfig(configPath);
  assert.equal(config.managementProfile, "org-setup");
  assert.equal(config.managementSetupRoleName, "OrgSetupRole");
});

test("rejects non-string managementProfile", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpFile = path.join(os.tmpdir(), "bad-mgmt-profile-org-config.yaml");

  fs.writeFileSync(
    tmpFile,
    `
region: us-east-1
identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test
  permissionSetName: Admin
  sessionDuration: PT1H
managementProfile: 123
organization:
  Infra:
    SharedSvc:
      account: true
      role: sharedServices
infraPipeline:
  name: P
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
  owner: test-owner
  repositoryName: R
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
      owner: test-owner
      repositoryName: R
      repositoryBranch: main
      crossAccountKeys: true
`,
    "utf-8",
  );

  assert.throws(
    () => parseOrgConfig(tmpFile),
    /managementProfile.*must be a string/,
  );

  fs.unlinkSync(tmpFile);
});

test("rejects config with missing region", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpFile = path.join(os.tmpdir(), "no-region-org-config.yaml");

  fs.writeFileSync(
    tmpFile,
    `
identity:
  userName: test
  givenName: Test
  familyName: User
  groupName: Admins
  groupDescription: Test
  permissionSetName: Admin
  sessionDuration: PT1H
organization:
  Infra:
    SharedSvc:
      account: true
      role: sharedServices
infraPipeline:
  name: P
  connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
  owner: test-owner
  repositoryName: R
  repositoryBranch: main
  crossAccountKeys: true
apps:
  - name: reboot
    pipeline:
      name: RebootPipeline
      connectionArn: "arn:aws:codeconnections:us-east-1:111111111111:connection/test"
      owner: test-owner
      repositoryName: R
      repositoryBranch: main
      crossAccountKeys: true
`,
    "utf-8",
  );

  assert.throws(() => parseOrgConfig(tmpFile), /region/);

  fs.unlinkSync(tmpFile);
});
