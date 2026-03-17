import assert from "node:assert/strict";
import test from "node:test";
import {
  findExistingAccountId,
  resolveOrRequestAccount,
} from "../scripts/org/build-org";

test("findExistingAccountId reuses existing account by expected email", () => {
  const accountId = findExistingAccountId(
    {
      accountName: "App 1 (dev)",
      accountEmail: "root_dev-app-1@example.com",
    },
    () => [
      {
        Id: "111111111111",
        Name: "App 1 (dev)",
        Email: "root_dev-app-1@example.com",
      },
    ],
  );

  assert.equal(accountId, "111111111111");
});

test("findExistingAccountId falls back to name when email is missing", () => {
  const accountId = findExistingAccountId(
    {
      accountName: "App 1 (prod)",
    },
    () => [
      {
        Id: "222222222222",
        Name: "App 1 (prod)",
        Email: "root_prod-app-1@example.com",
      },
    ],
  );

  assert.equal(accountId, "222222222222");
});

test("resolveOrRequestAccount requests create-account when no existing match", () => {
  const commands: string[] = [];

  const resolved = resolveOrRequestAccount(
    {
      accountName: "App 2 (dev)",
      accountEmail: "root_dev-app-2@example.com",
    },
    {
      findExistingAccountIdFn: () => undefined,
      awsExec: (command: string) => {
        commands.push(command);
        return "car-abc123";
      },
    },
  );

  assert.deepEqual(resolved, {
    requestId: "car-abc123",
    reused: false,
  });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("create-account"));
});

test("findExistingAccountId fails on conflicting email and name matches", () => {
  assert.throws(
    () =>
      findExistingAccountId(
        {
          accountName: "App 1 (dev)",
          accountEmail: "root_dev-app-1@example.com",
        },
        () => [
          {
            Id: "333333333333",
            Name: "App 1 (dev)",
            Email: "someone-else@example.com",
          },
          {
            Id: "444444444444",
            Name: "Different Name",
            Email: "root_dev-app-1@example.com",
          },
        ],
      ),
    /Conflicting existing accounts detected/,
  );
});
