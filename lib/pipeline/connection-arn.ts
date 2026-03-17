const CONNECTION_ARN_PATTERN =
  /^arn:(?<partition>aws[a-zA-Z-]*):(?<service>codeconnections|codestar-connections):(?<region>[a-z0-9-]+):(?<accountId>\d{12}):connection\/(?<connectionId>[A-Za-z0-9][A-Za-z0-9-]*)$/;

const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const REGION_PATTERN = /^[a-z0-9-]+$/;

export interface ParsedConnectionArn {
  readonly arn: string;
  readonly partition: string;
  readonly service: "codeconnections" | "codestar-connections";
  readonly region: string;
  readonly accountId: string;
  readonly connectionId: string;
}

export function parseConnectionArn(
  connectionArn: string,
): ParsedConnectionArn | null {
  const match = CONNECTION_ARN_PATTERN.exec(connectionArn.trim());
  if (!match?.groups) {
    return null;
  }

  return {
    arn: connectionArn,
    partition: match.groups.partition,
    service: match.groups.service as "codeconnections" | "codestar-connections",
    region: match.groups.region,
    accountId: match.groups.accountId,
    connectionId: match.groups.connectionId,
  };
}

export function assertValidConnectionArn(
  connectionArn: string,
  label: string,
): ParsedConnectionArn {
  const parsed = parseConnectionArn(connectionArn);
  if (!parsed) {
    throw new Error(
      `Invalid ${label} connectionArn "${connectionArn}". Expected an ARN like "arn:aws:codeconnections:<region>:<account-id>:connection/<connection-id>".`,
    );
  }

  if (parsed.connectionId.toLowerCase().includes("placeholder")) {
    throw new Error(
      `Invalid ${label} connectionArn "${connectionArn}". Placeholder connection IDs are not allowed.`,
    );
  }

  return parsed;
}

export interface ConnectionArnEnvironmentCheck {
  readonly label: string;
  readonly expectedAccountId?: string;
  readonly expectedRegion?: string;
}

export function assertConnectionArnMatchesEnvironment(
  parsed: ParsedConnectionArn,
  check: ConnectionArnEnvironmentCheck,
): void {
  if (
    check.expectedAccountId &&
    ACCOUNT_ID_PATTERN.test(check.expectedAccountId) &&
    parsed.accountId !== check.expectedAccountId
  ) {
    throw new Error(
      `Invalid ${check.label} connectionArn "${parsed.arn}". Connection account "${parsed.accountId}" must match stack account "${check.expectedAccountId}".`,
    );
  }

  if (
    check.expectedRegion &&
    REGION_PATTERN.test(check.expectedRegion) &&
    parsed.region !== check.expectedRegion
  ) {
    throw new Error(
      `Invalid ${check.label} connectionArn "${parsed.arn}". Connection region "${parsed.region}" must match stack region "${check.expectedRegion}".`,
    );
  }
}

export function connectionArnToUseConnectionActions(
  parsed: ParsedConnectionArn,
): Array<
  "codeconnections:UseConnection" | "codestar-connections:UseConnection"
> {
  return parsed.service === "codeconnections"
    ? ["codeconnections:UseConnection", "codestar-connections:UseConnection"]
    : ["codestar-connections:UseConnection", "codeconnections:UseConnection"];
}
