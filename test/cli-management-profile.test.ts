import assert from "node:assert/strict";
import test from "node:test";

// We need to test parseCliArgs with controlled argv, so we'll manipulate process.argv.

test("parseCliArgs parses --management-profile flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = ["node", "script.ts", "--management-profile", "my-profile"];
    // Re-require to get fresh parse
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.managementProfile, "my-profile");
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs parses --setup-role-name flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = ["node", "script.ts", "--setup-role-name", "CustomRole"];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.setupRoleName, "CustomRole");
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs parses --caller-profile flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = ["node", "script.ts", "--caller-profile", "caller"];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.callerProfile, "caller");
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs parses --trusted-principal-arn flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = [
      "node",
      "script.ts",
      "--trusted-principal-arn",
      "arn:aws:iam::123456789012:role/SSORole",
    ];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(
      args.trustedPrincipalArn,
      "arn:aws:iam::123456789012:role/SSORole",
    );
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs parses --write-config boolean flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = ["node", "script.ts", "--write-config"];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.writeConfig, true);
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs parses --cleanup boolean flag", () => {
  const origArgv = process.argv;
  try {
    process.argv = ["node", "script.ts", "--cleanup"];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.cleanup, true);
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs handles multiple new flags together", () => {
  const origArgv = process.argv;
  try {
    process.argv = [
      "node",
      "script.ts",
      "--management-profile",
      "org-setup",
      "--setup-role-name",
      "MyRole",
      "--cleanup",
    ];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.managementProfile, "org-setup");
    assert.equal(args.setupRoleName, "MyRole");
    assert.equal(args.cleanup, true);
  } finally {
    process.argv = origArgv;
  }
});

test("parseCliArgs preserves existing flags alongside new flags", () => {
  const origArgv = process.argv;
  try {
    process.argv = [
      "node",
      "script.ts",
      "--config",
      "/tmp/test.yaml",
      "--management-profile",
      "org-setup",
      "--skip-existing-accounts",
    ];
    delete require.cache[require.resolve("../scripts/org/cli")];
    const { parseCliArgs } = require("../scripts/org/cli");
    const args = parseCliArgs();
    assert.equal(args.config, "/tmp/test.yaml");
    assert.equal(args.managementProfile, "org-setup");
    assert.equal(args.skipExistingAccounts, true);
  } finally {
    process.argv = origArgv;
  }
});
