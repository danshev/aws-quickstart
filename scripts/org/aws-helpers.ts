import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OrgState } from "./types";

// ---------------------------------------------------------------------------
// State file — persists IDs between build-org ➜ move-accounts ➜ etc.
// ---------------------------------------------------------------------------

const STATE_FILE = path.resolve(process.cwd(), ".org-state.json");

export function readState(): OrgState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(
      `.org-state.json not found. Run 'npm run org:build' first.`,
    );
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as OrgState;
}

export function writeState(state: OrgState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// AWS CLI wrapper
// ---------------------------------------------------------------------------

/** Credential-related env vars that must be stripped when using a named profile. */
const CREDENTIAL_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
] as const;

export interface AwsExecOptions {
  /** Extra environment variables (e.g. assumed-role credentials). */
  env?: Record<string, string>;
  /** Suppress console output on error. */
  silent?: boolean;
  /** AWS CLI named profile. When set, credential env vars are stripped. */
  profile?: string;
}

/**
 * Build a clean env for the AWS CLI when a named profile is in use.
 * Strips credential env vars so the CLI resolves credentials from the profile
 * chain instead of inheriting stale env vars.
 */
export function buildAwsExecEnv(
  opts: AwsExecOptions,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env };

  if (opts.profile) {
    for (const key of CREDENTIAL_ENV_VARS) {
      base[key] = undefined;
    }
    base.AWS_PROFILE = opts.profile;
  }

  if (opts.env) {
    Object.assign(base, opts.env);
  }

  return base;
}

/**
 * Run an AWS CLI command and return the trimmed stdout.
 *
 * The command should omit the leading `aws ` — it is prepended automatically.
 */
export function aws(command: string, opts: AwsExecOptions = {}): string {
  const fullCommand = `aws ${command}`;
  try {
    return execSync(fullCommand, {
      encoding: "utf-8",
      env: buildAwsExecEnv(opts),
      stdio: opts.silent
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "inherit"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = extractExecErrorStderr(err);
    const hint = buildAwsErrorHint(stderr ?? message, opts);
    const parts = [`AWS CLI failed: ${fullCommand}`, message];
    if (stderr) {
      parts.push(stderr);
    }
    if (hint) {
      parts.push(hint);
    }
    throw new Error(parts.join("\n"));
  }
}

function extractExecErrorStderr(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("stderr" in err)) {
    return undefined;
  }

  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") {
    const trimmed = stderr.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (stderr instanceof Buffer) {
    const trimmed = stderr.toString("utf-8").trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

/**
 * Provide a contextual hint for common AWS CLI errors.
 */
export function buildAwsErrorHint(
  errorText: string,
  opts: AwsExecOptions,
): string | undefined {
  if (
    errorText.includes("AssumeRole") &&
    errorText.includes("not authorized")
  ) {
    return "Hint: The root user cannot call sts:AssumeRole. Run `npm run org:setup-principal` to create a non-root principal first.";
  }
  if (errorText.includes("could not be found")) {
    if (opts.profile) {
      return `Hint: Profile "${opts.profile}" was not found. Check ~/.aws/config.`;
    }
  }
  return undefined;
}

/**
 * Run an AWS CLI command and parse the JSON output.
 */
export function awsJson<T = unknown>(
  command: string,
  opts: AwsExecOptions = {},
): T {
  const raw = aws(`${command} --output json`, opts);
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// STS / caller-identity helpers
// ---------------------------------------------------------------------------

export interface CallerIdentity {
  Account: string;
  Arn: string;
  UserId: string;
}

export function getCallerIdentity(opts: AwsExecOptions = {}): CallerIdentity {
  return awsJson<CallerIdentity>("sts get-caller-identity", opts);
}

/** Returns true if the ARN looks like a root user (no IAM user/role path). */
export function isRootArn(arn: string): boolean {
  return /^arn:aws:iam::\d{12}:root$/.test(arn);
}

/** Returns the management account ID for the organization. */
export function getOrganizationManagementAccountId(
  opts: AwsExecOptions = {},
): string {
  const org = awsJson<{ Organization: { MasterAccountId: string } }>(
    "organizations describe-organization",
    opts,
  );
  return org.Organization.MasterAccountId;
}

/**
 * Throws if the current caller is the root user.
 * Use this as a preflight gate in scripts that need sts:AssumeRole.
 */
export function assertNonRootCaller(identity: CallerIdentity): void {
  if (isRootArn(identity.Arn)) {
    throw new Error(
      "This script cannot run as the root user because root cannot call sts:AssumeRole.\n" +
        "Run `npm run org:setup-principal` first to create a non-root principal,\n" +
        "then configure the profile and retry.",
    );
  }
}

/**
 * Throws if the caller is not operating in the management account.
 */
export function assertManagementAccountContext(
  callerAccountId: string,
  managementAccountId: string,
): void {
  if (callerAccountId !== managementAccountId) {
    throw new Error(
      `This script must run in the management account (${managementAccountId}), ` +
        `but the current caller is in account ${callerAccountId}.`,
    );
  }
}

/**
 * Resolve the AWS CLI profile to use for management-account operations.
 * CLI flag takes precedence over the config value.
 */
export function resolveManagementProfile(
  cliProfile: string | undefined,
  configProfile: string | undefined,
): string | undefined {
  return cliProfile ?? configProfile;
}

// ---------------------------------------------------------------------------
// STS helpers
// ---------------------------------------------------------------------------

export interface AssumedCredentials {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
}

/**
 * Assume a cross-account role and return temporary credentials as env vars.
 */
export function assumeRole(
  accountId: string,
  roleName: string,
  sessionName: string,
  opts: AwsExecOptions = {},
): AssumedCredentials {
  const result = awsJson<{
    Credentials: {
      AccessKeyId: string;
      SecretAccessKey: string;
      SessionToken: string;
    };
  }>(
    `sts assume-role --role-arn arn:aws:iam::${accountId}:role/${roleName} --role-session-name ${sessionName}`,
    opts,
  );

  return {
    AWS_ACCESS_KEY_ID: result.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: result.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: result.Credentials.SessionToken,
  };
}

/**
 * Execute a callback with temporary credentials from an assumed role.
 * The caller's environment is not mutated.
 */
export function withAssumedRole<T>(
  accountId: string,
  roleName: string,
  sessionName: string,
  fn: (env: AssumedCredentials) => T,
  opts: AwsExecOptions = {},
): T {
  const creds = assumeRole(accountId, roleName, sessionName, opts);
  return fn(creds);
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(emoji: string, message: string): void {
  console.log(`${emoji}  ${message}`);
}

export function logStep(message: string): void {
  log("🔹", message);
}

export function logSuccess(message: string): void {
  log("✅", message);
}

export function logWarn(message: string): void {
  log("⚠️", message);
}

export function logError(message: string): void {
  log("❌", message);
}
