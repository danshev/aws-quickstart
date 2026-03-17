import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { OrgAccount, OrgAppConfig, OrgConfig, OuPath } from "./types";

// ---------------------------------------------------------------------------
// Locate the config file relative to this script.
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.resolve(__dirname, "org-config.yaml");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawAccountNode {
  account: true;
  role?: string;
  stage?: string;
  requiresManualApproval?: boolean;
  app?: string;
}

type OrgTreeNode = RawAccountNode | Record<string, unknown>;

function isAccountNode(node: unknown): node is RawAccountNode {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as Record<string, unknown>).account === true
  );
}

/**
 * Recursively walk the organization tree and collect OUs and accounts.
 * OUs are returned in depth-first pre-order (parents before children).
 */
function walkTree(
  tree: Record<string, OrgTreeNode>,
  parentPath: string[] = [],
): { ous: OuPath[]; accounts: OrgAccount[] } {
  const ous: OuPath[] = [];
  const accounts: OrgAccount[] = [];

  for (const [name, node] of Object.entries(tree)) {
    if (isAccountNode(node)) {
      if (node.stage && !node.app) {
        throw new Error(
          `org-config.yaml: account "${name}" has stage "${node.stage}" but no app. ` +
            `Every account with a stage must also specify an app.`,
        );
      }

      accounts.push({
        name,
        ouPath: parentPath,
        stage: node.stage,
        requiresManualApproval: node.requiresManualApproval,
        role: node.role,
        app: node.app,
      });
    } else {
      // It's an OU. Bare YAML keys (e.g. "Security:") parse as null — still a
      // valid empty OU, so register it regardless.
      const currentPath = [...parentPath, name];
      ous.push(currentPath);

      if (typeof node === "object" && node !== null) {
        // Recurse into children.
        const children = walkTree(
          node as Record<string, OrgTreeNode>,
          currentPath,
        );
        ous.push(...children.ous);
        accounts.push(...children.accounts);
      }
    }
  }

  return { ous, accounts };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseOrgConfig(configPath: string = CONFIG_PATH): OrgConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Org config not found at ${configPath}`);
  }

  const raw = YAML.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;

  // --- Validate top-level keys ---

  const region = raw.region as string | undefined;
  if (!region || typeof region !== "string") {
    throw new Error("org-config.yaml: 'region' is required.");
  }

  const identity = raw.identity as OrgConfig["identity"] | undefined;
  if (!identity || typeof identity !== "object") {
    throw new Error("org-config.yaml: 'identity' section is required.");
  }
  for (const key of [
    "userName",
    "givenName",
    "familyName",
    "groupName",
    "groupDescription",
    "permissionSetName",
    "sessionDuration",
  ] as const) {
    if (!identity[key]) {
      throw new Error(`org-config.yaml: 'identity.${key}' is required.`);
    }
  }

  const crossAccountRoleName =
    (raw.crossAccountRoleName as string) ?? "OrganizationAccountAccessRole";

  const organization = raw.organization as Record<string, OrgTreeNode>;
  if (!organization || typeof organization !== "object") {
    throw new Error("org-config.yaml: 'organization' section is required.");
  }

  const infraPipeline = raw.infraPipeline as
    | OrgConfig["infraPipeline"]
    | undefined;
  if (!infraPipeline || typeof infraPipeline !== "object") {
    throw new Error("org-config.yaml: 'infraPipeline' section is required.");
  }

  const rawApps = (raw.apps as OrgAppConfig[] | undefined) ?? [];

  const network = raw.network as OrgConfig["network"] | undefined;

  const managementProfile = raw.managementProfile as string | undefined;
  if (
    managementProfile !== undefined &&
    typeof managementProfile !== "string"
  ) {
    throw new Error("org-config.yaml: 'managementProfile' must be a string.");
  }

  const managementSetupRoleName = raw.managementSetupRoleName as
    | string
    | undefined;
  if (
    managementSetupRoleName !== undefined &&
    typeof managementSetupRoleName !== "string"
  ) {
    throw new Error(
      "org-config.yaml: 'managementSetupRoleName' must be a string.",
    );
  }

  // --- Walk the tree ---

  const { ous, accounts } = walkTree(organization);

  const sharedServices = accounts.find((a) => a.role === "sharedServices");
  if (!sharedServices) {
    throw new Error(
      "org-config.yaml: exactly one account must have role: sharedServices.",
    );
  }

  return {
    region,
    identity,
    crossAccountRoleName,
    accounts,
    ous,
    infraPipeline,
    apps: rawApps,
    network,
    managementProfile,
    managementSetupRoleName,
  };
}

/** Return just the shared-services account entry (convenience). */
export function getSharedServicesAccount(config: OrgConfig): OrgAccount {
  const account = config.accounts.find((a) => a.role === "sharedServices");
  if (!account) {
    throw new Error("No account with role: sharedServices found in config.");
  }
  return account;
}

/** Return all accounts that define a `stage` (i.e. CDK deployment targets). */
export function getDeploymentTargets(config: OrgConfig): OrgAccount[] {
  return config.accounts.filter((a) => a.stage !== undefined);
}

/** Return deployment target accounts grouped by app name. */
export function getDeploymentTargetsByApp(
  config: OrgConfig,
): Map<string, OrgAccount[]> {
  const byApp = new Map<string, OrgAccount[]>();
  for (const account of config.accounts) {
    if (account.stage && account.app) {
      const list = byApp.get(account.app) ?? [];
      list.push(account);
      byApp.set(account.app, list);
    }
  }
  return byApp;
}
