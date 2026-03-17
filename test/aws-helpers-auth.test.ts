import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagementAccountContext,
  assertNonRootCaller,
  buildAwsErrorHint,
  buildAwsExecEnv,
  isRootArn,
  resolveManagementProfile,
} from "../scripts/org/aws-helpers";

test("isRootArn returns true for root ARN", () => {
  assert.ok(isRootArn("arn:aws:iam::123456789012:root"));
});

test("isRootArn returns false for IAM user ARN", () => {
  assert.ok(!isRootArn("arn:aws:iam::123456789012:user/Admin"));
});

test("isRootArn returns false for IAM role ARN", () => {
  assert.ok(!isRootArn("arn:aws:iam::123456789012:role/OrgSetupRole"));
});

test("isRootArn returns false for assumed role ARN", () => {
  assert.ok(
    !isRootArn("arn:aws:sts::123456789012:assumed-role/OrgSetupRole/session"),
  );
});

test("buildAwsExecEnv strips credential env vars when profile is set", () => {
  // Temporarily set env vars to test stripping
  const origAccessKey = process.env.AWS_ACCESS_KEY_ID;
  const origSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const origToken = process.env.AWS_SESSION_TOKEN;
  const origProfile = process.env.AWS_PROFILE;

  try {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "SECRET_TEST";
    process.env.AWS_SESSION_TOKEN = "TOKEN_TEST";

    const env = buildAwsExecEnv({ profile: "test-profile" });
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
    assert.equal(env.AWS_PROFILE, "test-profile");
  } finally {
    // Restore
    if (origAccessKey !== undefined) {
      process.env.AWS_ACCESS_KEY_ID = origAccessKey;
    } else {
      delete process.env.AWS_ACCESS_KEY_ID;
    }
    if (origSecretKey !== undefined) {
      process.env.AWS_SECRET_ACCESS_KEY = origSecretKey;
    } else {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
    if (origToken !== undefined) {
      process.env.AWS_SESSION_TOKEN = origToken;
    } else {
      delete process.env.AWS_SESSION_TOKEN;
    }
    if (origProfile !== undefined) {
      process.env.AWS_PROFILE = origProfile;
    } else {
      delete process.env.AWS_PROFILE;
    }
  }
});

test("buildAwsExecEnv preserves env vars when no profile is set", () => {
  const origAccessKey = process.env.AWS_ACCESS_KEY_ID;

  try {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";

    const env = buildAwsExecEnv({});
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIA_TEST");
  } finally {
    if (origAccessKey !== undefined) {
      process.env.AWS_ACCESS_KEY_ID = origAccessKey;
    } else {
      delete process.env.AWS_ACCESS_KEY_ID;
    }
  }
});

test("buildAwsExecEnv merges extra env vars on top of profile", () => {
  const env = buildAwsExecEnv({
    profile: "test-profile",
    env: { CUSTOM_VAR: "hello" },
  });
  assert.equal(env.AWS_PROFILE, "test-profile");
  assert.equal(env.CUSTOM_VAR, "hello");
});

test("assertNonRootCaller throws for root ARN", () => {
  assert.throws(
    () =>
      assertNonRootCaller({
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:root",
        UserId: "123456789012",
      }),
    /cannot run as the root user/,
  );
});

test("assertNonRootCaller does not throw for IAM role ARN", () => {
  assert.doesNotThrow(() =>
    assertNonRootCaller({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/OrgSetupRole/session",
      UserId: "AROA:session",
    }),
  );
});

test("assertManagementAccountContext throws for wrong account", () => {
  assert.throws(
    () => assertManagementAccountContext("999999999999", "123456789012"),
    /must run in the management account/,
  );
});

test("assertManagementAccountContext does not throw for correct account", () => {
  assert.doesNotThrow(() =>
    assertManagementAccountContext("123456789012", "123456789012"),
  );
});

test("resolveManagementProfile prefers CLI over config", () => {
  assert.equal(
    resolveManagementProfile("cli-profile", "config-profile"),
    "cli-profile",
  );
});

test("resolveManagementProfile falls back to config", () => {
  assert.equal(
    resolveManagementProfile(undefined, "config-profile"),
    "config-profile",
  );
});

test("resolveManagementProfile returns undefined when neither set", () => {
  assert.equal(resolveManagementProfile(undefined, undefined), undefined);
});

test("buildAwsErrorHint returns hint for AssumeRole authorization failure", () => {
  const hint = buildAwsErrorHint(
    "An error occurred: User is not authorized to perform: sts:AssumeRole",
    {},
  );
  assert.ok(hint);
  assert.ok(hint.includes("org:setup-principal"));
});

test("buildAwsErrorHint returns hint for missing profile", () => {
  const hint = buildAwsErrorHint(
    "The config profile (my-profile) could not be found",
    { profile: "my-profile" },
  );
  assert.ok(hint);
  assert.ok(hint.includes("my-profile"));
});

test("buildAwsErrorHint returns undefined for unrelated errors", () => {
  const hint = buildAwsErrorHint("Some random error", {});
  assert.equal(hint, undefined);
});
