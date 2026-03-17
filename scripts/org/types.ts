// ---------------------------------------------------------------------------
// Types shared across all org-management scripts.
// ---------------------------------------------------------------------------

/** IAM Identity Center operator identity. */
export interface IdentityConfig {
  userName: string;
  givenName: string;
  familyName: string;
  groupName: string;
  groupDescription: string;
  permissionSetName: string;
  /** ISO 8601 duration, e.g. "PT8H". */
  sessionDuration: string;
}

/** Path-based trigger filter for CodePipeline V2. */
export interface TriggerPathFilter {
  filePathsIncludes?: string[];
  filePathsExcludes?: string[];
}

/** Pipeline settings that flow into config/defaults.ts. */
export interface PipelineConfig {
  name: string;
  connectionArn: string;
  owner: string;
  repositoryName: string;
  repositoryBranch: string;
  crossAccountKeys: boolean;
  triggerOnPaths?: TriggerPathFilter;
}

/** Per-app config parsed from org-config.yaml. */
export interface OrgAppConfig {
  name: string;
  pipeline: PipelineConfig;
}

/** Transit Gateway centralized egress settings. */
export interface OrgNetworkConfig {
  egressVpcCidr: string;
  spokeCidrs: Record<string, string>;
  tgwAsn?: number;
}

/** A single AWS account discovered in the organization tree. */
export interface OrgAccount {
  /** Human-readable name, e.g. "Shared Services". */
  name: string;
  /** Full OU ancestry from root, e.g. ["Workloads", "Dev"]. */
  ouPath: string[];
  /** CDK deployment-target stage name, e.g. "dev". */
  stage?: string;
  /** Whether the CDK pipeline requires manual approval for this stage. */
  requiresManualApproval?: boolean;
  /** Semantic role tag. "sharedServices" marks the pipeline-owning account. */
  role?: string;
  /** App name this account belongs to, e.g. "reboot". */
  app?: string;
}

/** An OU expressed as its full path from the org root. */
export type OuPath = string[];

/** Top-level parsed config returned by parse-org-config. */
export interface OrgConfig {
  region: string;
  identity: IdentityConfig;
  crossAccountRoleName: string;
  /** Flattened list of accounts from the organization tree. */
  accounts: OrgAccount[];
  /** All OUs as path arrays, topologically sorted (parents before children). */
  ous: OuPath[];
  infraPipeline: PipelineConfig;
  apps: OrgAppConfig[];
  network?: OrgNetworkConfig;
  /** AWS CLI profile for the management setup role (set by org:setup-principal). */
  managementProfile?: string;
  /** IAM role name created in the management account (set by org:setup-principal). */
  managementSetupRoleName?: string;
}

// ---------------------------------------------------------------------------
// Runtime tracking types (persisted to .org-state.json between scripts).
// ---------------------------------------------------------------------------

export interface AccountRequest {
  requestId: string;
  accountName: string;
  /** Expected account email used during account creation/recovery. */
  accountEmail?: string;
  /** Whether this account was detected as pre-existing during org:build. */
  existingAccount?: boolean;
  targetOuPath: string[];
  /** Populated after account creation succeeds or existing-account resolution. */
  accountId?: string;
}

export interface OuRecord {
  path: string[];
  ouId: string;
}

export interface OrgState {
  rootId: string;
  managementEmail: string;
  accountRequests: AccountRequest[];
  ous: OuRecord[];
}
