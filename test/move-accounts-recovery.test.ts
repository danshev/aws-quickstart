import assert from "node:assert/strict";
import test from "node:test";
import {
  getCurrentParentId,
  moveAccountWithCurrentParent,
  recoverAccountIdFromExistingFailure,
} from "../scripts/org/move-accounts";

test("recoverAccountIdFromExistingFailure resolves account ID and avoids skip path", () => {
  const recovered = recoverAccountIdFromExistingFailure(
    {
      requestId: "car-123",
      accountName: "App 1 (dev)",
      accountEmail: "root_dev-app-1@example.com",
      targetOuPath: ["Workloads", "Dev"],
    },
    () => "555555555555",
  );

  assert.equal(recovered, "555555555555");
});

test("getCurrentParentId resolves current parent from list-parents response", () => {
  const parentId = getCurrentParentId("111111111111", () => ({
    Parents: [{ Id: "ou-current", Type: "ORGANIZATIONAL_UNIT" }],
  }));

  assert.equal(parentId, "ou-current");
});

test("moveAccountWithCurrentParent uses current parent as source parent", () => {
  const commands: string[] = [];

  const result = moveAccountWithCurrentParent("111111111111", "ou-target", {
    getCurrentParentIdFn: () => "ou-source",
    awsExec: (command: string) => {
      commands.push(command);
      return "";
    },
  });

  assert.equal(result, "moved");
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("--source-parent-id ou-source"));
  assert.ok(commands[0].includes("--destination-parent-id ou-target"));
});

test("moveAccountWithCurrentParent skips move when already under target OU", () => {
  let called = false;

  const result = moveAccountWithCurrentParent("111111111111", "ou-target", {
    getCurrentParentIdFn: () => "ou-target",
    awsExec: () => {
      called = true;
      return "";
    },
  });

  assert.equal(result, "already-in-target");
  assert.equal(called, false);
});
