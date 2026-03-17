import assert from "node:assert/strict";
import test from "node:test";
import {
  findExistingOuId,
  listChildOus,
  resolveOrCreateOu,
  resolveOuHierarchy,
} from "../scripts/org/build-org";

test("findExistingOuId reuses existing top-level OU by exact name", () => {
  const ouId = findExistingOuId("r-root", "Infrastructure", () => [
    { Id: "ou-aaaa", Name: "Infrastructure" },
    { Id: "ou-bbbb", Name: "Workloads" },
  ]);

  assert.equal(ouId, "ou-aaaa");
});

test("resolveOuHierarchy resolves nested OU under reused parent OU ID", () => {
  const calls: Array<{ parentId: string; ouName: string }> = [];
  const resolverTable = new Map<string, { ouId: string; reused: boolean }>([
    ["r-root|Infrastructure", { ouId: "ou-infra", reused: true }],
    ["r-root|Workloads", { ouId: "ou-workloads", reused: true }],
    ["ou-workloads|Dev", { ouId: "ou-dev", reused: true }],
  ]);

  const resolved = resolveOuHierarchy(
    [["Infrastructure"], ["Workloads"], ["Workloads", "Dev"]],
    "r-root",
    (parentId, ouName) => {
      calls.push({ parentId, ouName });
      const key = `${parentId}|${ouName}`;
      const entry = resolverTable.get(key);
      assert.ok(entry, `Unexpected resolver lookup for ${key}`);
      return entry;
    },
  );

  assert.deepEqual(calls, [
    { parentId: "r-root", ouName: "Infrastructure" },
    { parentId: "r-root", ouName: "Workloads" },
    { parentId: "ou-workloads", ouName: "Dev" },
  ]);
  assert.equal(resolved[2].ouId, "ou-dev");
  assert.equal(resolved[2].reused, true);
});

test("resolveOrCreateOu creates OU when not found", () => {
  const commands: string[] = [];
  const result = resolveOrCreateOu("ou-parent", "Security", {
    findExistingOuIdFn: () => undefined,
    awsExec: (command: string) => {
      commands.push(command);
      return "ou-new";
    },
  });

  assert.deepEqual(result, { ouId: "ou-new", reused: false });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("create-organizational-unit"));
  assert.ok(commands[0].includes("--parent-id ou-parent"));
  assert.ok(commands[0].includes('--name "Security"'));
});

test("resolveOuHierarchy handles mixed reused+created OUs and returns all paths", () => {
  const resolverTable = new Map<string, { ouId: string; reused: boolean }>([
    ["r-root|Infrastructure", { ouId: "ou-infra", reused: true }],
    ["r-root|Workloads", { ouId: "ou-workloads", reused: false }],
    ["ou-workloads|Dev", { ouId: "ou-dev", reused: true }],
    ["ou-workloads|Prod", { ouId: "ou-prod", reused: false }],
  ]);

  const resolved = resolveOuHierarchy(
    [
      ["Infrastructure"],
      ["Workloads"],
      ["Workloads", "Dev"],
      ["Workloads", "Prod"],
    ],
    "r-root",
    (parentId, ouName) => {
      const entry = resolverTable.get(`${parentId}|${ouName}`);
      assert.ok(entry);
      return entry;
    },
  );

  assert.equal(resolved.length, 4);
  assert.deepEqual(
    resolved.map((r) => ({
      key: r.path.join("/"),
      ouId: r.ouId,
      reused: r.reused,
    })),
    [
      { key: "Infrastructure", ouId: "ou-infra", reused: true },
      { key: "Workloads", ouId: "ou-workloads", reused: false },
      { key: "Workloads/Dev", ouId: "ou-dev", reused: true },
      { key: "Workloads/Prod", ouId: "ou-prod", reused: false },
    ],
  );
});

test("findExistingOuId fails fast on duplicate OU names under same parent", () => {
  assert.throws(
    () =>
      findExistingOuId("ou-parent", "Infrastructure", () => [
        { Id: "ou-1", Name: "Infrastructure" },
        { Id: "ou-2", Name: "Infrastructure" },
      ]),
    /Multiple OUs named "Infrastructure"/,
  );
});

test("listChildOus follows pagination until NextToken is exhausted", () => {
  const commands: string[] = [];

  const all = listChildOus("ou-parent", (command: string) => {
    commands.push(command);

    if (command.includes('--starting-token "tok-1"')) {
      return {
        OrganizationalUnits: [{ Id: "ou-2", Name: "Dev" }],
      };
    }

    return {
      OrganizationalUnits: [{ Id: "ou-1", Name: "Infrastructure" }],
      NextToken: "tok-1",
    };
  });

  assert.deepEqual(all, [
    { Id: "ou-1", Name: "Infrastructure" },
    { Id: "ou-2", Name: "Dev" },
  ]);
  assert.equal(commands.length, 2);
});

test("resolveOrCreateOu handles duplicate-on-create race by re-querying", () => {
  let lookupCount = 0;
  let createCount = 0;

  const result = resolveOrCreateOu("ou-parent", "Infrastructure", {
    findExistingOuIdFn: () => {
      lookupCount += 1;
      return lookupCount >= 2 ? "ou-existing" : undefined;
    },
    awsExec: () => {
      createCount += 1;
      throw new Error("DuplicateOrganizationalUnitException");
    },
  });

  assert.deepEqual(result, { ouId: "ou-existing", reused: true });
  assert.equal(createCount, 1);
  assert.equal(lookupCount, 2);
});
