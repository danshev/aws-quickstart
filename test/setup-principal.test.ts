import assert from "node:assert/strict";
import test from "node:test";
import {
  arePolicyDocumentsEqual,
  buildOrgSetupPermissionsPolicy,
  buildTrustPolicyDocument,
  buildUserAssumeRolePolicy,
  renderAwsCredentialsSnippet,
  renderAwsProfileSnippet,
  upsertSetupConfigValues,
} from "../scripts/org/setup-principal";

test("buildTrustPolicyDocument produces valid trust policy with account root and user", () => {
  const doc = buildTrustPolicyDocument("123456789012", [
    "arn:aws:iam::123456789012:user/OrgSetupUser",
  ]);

  assert.equal(doc.Version, "2012-10-17");
  const statements = doc.Statement as Array<Record<string, unknown>>;
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Effect, "Allow");
  assert.equal(statements[0].Action, "sts:AssumeRole");

  const principal = statements[0].Principal as Record<string, unknown>;
  const awsPrincipals = principal.AWS as string[];
  assert.equal(awsPrincipals.length, 2);
  assert.ok(awsPrincipals.includes("arn:aws:iam::123456789012:root"));
  assert.ok(
    awsPrincipals.includes("arn:aws:iam::123456789012:user/OrgSetupUser"),
  );
});

test("buildTrustPolicyDocument with no extra ARNs uses single principal string", () => {
  const doc = buildTrustPolicyDocument("123456789012", []);
  const statements = doc.Statement as Array<Record<string, unknown>>;
  const principal = statements[0].Principal as Record<string, unknown>;
  assert.equal(principal.AWS, "arn:aws:iam::123456789012:root");
});

test("buildOrgSetupPermissionsPolicy includes org, cloudtrail, access-analyzer, and cross-account actions", () => {
  const doc = buildOrgSetupPermissionsPolicy("OrganizationAccountAccessRole");
  const statements = doc.Statement as Array<Record<string, unknown>>;
  assert.equal(statements.length, 4);

  const orgStmt = statements.find((s) => s.Sid === "OrganizationsReadWrite");
  assert.ok(orgStmt);
  assert.deepEqual(orgStmt.Action, [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
    "organizations:ListAWSServiceAccessForOrganization",
    "organizations:EnableAWSServiceAccess",
    "organizations:ListDelegatedAdministrators",
    "organizations:RegisterDelegatedAdministrator",
    "organizations:DeregisterDelegatedAdministrator",
  ]);

  const cloudTrailStmt = statements.find((s) => s.Sid === "CloudTrailAdmin");
  assert.ok(cloudTrailStmt);
  assert.deepEqual(cloudTrailStmt.Action, [
    "cloudtrail:RegisterOrganizationDelegatedAdmin",
    "cloudtrail:DeregisterOrganizationDelegatedAdmin",
    "iam:CreateServiceLinkedRole",
    "iam:GetRole",
  ]);

  const analyzerStmt = statements.find((s) => s.Sid === "AccessAnalyzer");
  assert.ok(analyzerStmt);

  const assumeStmt = statements.find((s) => s.Sid === "CrossAccountAssume");
  assert.ok(assumeStmt);
  assert.equal(assumeStmt.Action, "sts:AssumeRole");
  assert.equal(
    assumeStmt.Resource,
    "arn:aws:iam::*:role/OrganizationAccountAccessRole",
  );
});

test("buildUserAssumeRolePolicy scopes to specific role ARN", () => {
  const roleArn = "arn:aws:iam::123456789012:role/OrgSetupRole";
  const doc = buildUserAssumeRolePolicy(roleArn);
  const statements = doc.Statement as Array<Record<string, unknown>>;
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Action, "sts:AssumeRole");
  assert.equal(statements[0].Resource, roleArn);
});

test("arePolicyDocumentsEqual returns true for identical documents", () => {
  const a = buildOrgSetupPermissionsPolicy("TestRole");
  const b = buildOrgSetupPermissionsPolicy("TestRole");
  assert.ok(arePolicyDocumentsEqual(a, b));
});

test("arePolicyDocumentsEqual returns false for different documents", () => {
  const a = buildOrgSetupPermissionsPolicy("RoleA");
  const b = buildOrgSetupPermissionsPolicy("RoleB");
  assert.ok(!arePolicyDocumentsEqual(a, b));
});

test("arePolicyDocumentsEqual is order-independent for statements", () => {
  const a = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "A", Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
      { Sid: "B", Effect: "Allow", Action: "s3:PutObject", Resource: "*" },
    ],
  };
  const b = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "B", Effect: "Allow", Action: "s3:PutObject", Resource: "*" },
      { Sid: "A", Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
    ],
  };
  assert.ok(arePolicyDocumentsEqual(a, b));
});

test("upsertSetupConfigValues inserts values after crossAccountRoleName", () => {
  const yaml = `region: us-east-1
crossAccountRoleName: OrganizationAccountAccessRole

organization:
  Infra:`;

  const result = upsertSetupConfigValues(yaml, "org-setup", "OrgSetupRole");
  assert.ok(result.includes("managementProfile: org-setup"));
  assert.ok(result.includes("managementSetupRoleName: OrgSetupRole"));
  // Should appear after crossAccountRoleName
  const crossIdx = result.indexOf("crossAccountRoleName:");
  const profileIdx = result.indexOf("managementProfile:");
  const roleIdx = result.indexOf("managementSetupRoleName:");
  assert.ok(profileIdx > crossIdx);
  assert.ok(roleIdx > profileIdx);
});

test("upsertSetupConfigValues updates existing values", () => {
  const yaml = `region: us-east-1
crossAccountRoleName: OrganizationAccountAccessRole
managementProfile: old-profile
managementSetupRoleName: OldRole

organization:`;

  const result = upsertSetupConfigValues(yaml, "new-profile", "NewRole");
  assert.ok(result.includes("managementProfile: new-profile"));
  assert.ok(result.includes("managementSetupRoleName: NewRole"));
  assert.ok(!result.includes("old-profile"));
  assert.ok(!result.includes("OldRole"));
});

test("upsertSetupConfigValues uncomments commented values", () => {
  const yaml = `region: us-east-1
crossAccountRoleName: OrganizationAccountAccessRole
# managementProfile: org-setup
# managementSetupRoleName: OrgSetupRole

organization:`;

  const result = upsertSetupConfigValues(yaml, "org-setup", "OrgSetupRole");
  assert.ok(result.includes("managementProfile: org-setup"));
  assert.ok(result.includes("managementSetupRoleName: OrgSetupRole"));
  assert.ok(!result.includes("# managementProfile:"));
  assert.ok(!result.includes("# managementSetupRoleName:"));
});

test("renderAwsCredentialsSnippet produces valid ini format", () => {
  const snippet = renderAwsCredentialsSnippet(
    "org-setup",
    "AKIAIOSFODNN7EXAMPLE",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  );
  assert.ok(snippet.includes("[org-setup-user]"));
  assert.ok(snippet.includes("aws_access_key_id = AKIAIOSFODNN7EXAMPLE"));
  assert.ok(
    snippet.includes(
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ),
  );
});

test("renderAwsProfileSnippet produces valid ini format", () => {
  const snippet = renderAwsProfileSnippet(
    "org-setup",
    "arn:aws:iam::123456789012:role/OrgSetupRole",
    "us-east-1",
  );
  assert.ok(snippet.includes("[profile org-setup]"));
  assert.ok(
    snippet.includes("role_arn = arn:aws:iam::123456789012:role/OrgSetupRole"),
  );
  assert.ok(snippet.includes("source_profile = org-setup-user"));
  assert.ok(snippet.includes("region = us-east-1"));
});
