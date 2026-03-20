export type StageName = "dev" | "prod" | string;

/** A monthly cost budget alert covering one or more AWS services under a shared threshold. */
export interface ServiceBudgetAlert {
  /**
   * One or more AWS service display names as they appear in Cost Explorer.
   * Use multiple entries to group related services under a single budget
   * (e.g. "Amazon Bedrock" and "Claude Sonnet 4.6 ( Bedrock Edition)").
   * Examples: "Amazon Bedrock", "Amazon DynamoDB", "AWS Lambda"
   */
  services: string[];
  /** Monthly cost threshold in USD that triggers the alert. */
  monthlyThresholdUsd: number;
}

export interface DeploymentTarget {
  name: StageName;
  accountId: string;
  region: string;
  requiresManualApproval?: boolean;
  /** Spoke VPC CIDR for this target (required when network is enabled). */
  spokeCidr?: string;
  /**
   * Per-service monthly cost budget alerts for this stage.
   * Requires AppConfig.alertEmail to be set. Each entry creates one AWS Budget.
   */
  serviceBudgets?: ServiceBudgetAlert[];
}

export interface TriggerPathFilter {
  filePathsIncludes?: string[];
  filePathsExcludes?: string[];
}

export interface PipelineConfig {
  name: string;
  connectionArn: string;
  owner: string;
  repositoryName: string;
  repositoryBranch: string;
  crossAccountKeys: boolean;
  triggerOnPaths?: TriggerPathFilter;
}

export interface DomainConfig {
  /** Root domain, e.g. "example.com". Prod uses this directly; other stages get "{stage}.{rootDomain}". */
  rootDomain: string;
  /** Name of the IAM role in Shared Services that workload accounts assume for Route 53 delegation. */
  delegationRoleName: string;
  /** Vercel CNAME target for frontend routing, e.g. "cname.vercel-dns.com". When set, creates apex A + www CNAME records in prod. */
  vercelCname?: string;
}

export interface NetworkConfig {
  /** CIDR for the Egress VPC in Shared Services, e.g. "10.0.0.0/16". */
  egressVpcCidr: string;
  /** BGP ASN for the Transit Gateway. Defaults to 64512. */
  tgwAsn?: number;
}

export interface ApolloGraphQLConfig {
  /** Lambda memory in MB. Default: 1024. */
  lambdaMemoryMb?: number;
  /** Lambda timeout in seconds. Default: 30. */
  lambdaTimeoutSeconds?: number;
  /** Whether Cognito self-sign-up is enabled. Default: true. */
  selfSignUpEnabled?: boolean;
  /** Minimum password length for Cognito. Default: 8. */
  passwordMinLength?: number;
  /** Number of provisioned concurrent executions. Default: 0 (disabled). */
  provisionedConcurrency?: number;
}

export interface SecurityConfig {
  /** AWS account ID for the Log Archive account. */
  logArchiveAccountId: string;
  /** AWS account ID for the Audit account. */
  auditAccountId: string;
  /** Email address for budget and cost anomaly alerts. */
  alertEmail?: string;
  /** Monthly cost budget in USD. Defaults to 1000. */
  monthlyBudgetUsd?: number;
  /** Allowed AWS regions for region-deny SCP. Defaults to the org-config region. */
  allowedRegions?: string[];
}

export interface StripeConfig {
  /** Partner event source name from Stripe, e.g. "aws.partner/stripe.com/ed_xxx" */
  eventSourceName: string;
  /** Secrets Manager secret name for the Stripe API key */
  stripeSecretName: string;
}

export interface AppConfig {
  name: string;
  pipeline: PipelineConfig;
  deploymentTargets: DeploymentTarget[];
  domain?: DomainConfig;
  apolloGraphQL?: ApolloGraphQLConfig;
  stripe?: StripeConfig;
  /** Email address for app-level cost alerts (e.g. service budget notifications). */
  alertEmail?: string;
}

export interface BootstrapConfig {
  sharedServicesAccountId: string;
  infraPipeline: PipelineConfig;
  security?: SecurityConfig;
  network?: NetworkConfig;
  apps: AppConfig[];
}
