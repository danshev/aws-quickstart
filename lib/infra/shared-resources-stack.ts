import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ram from "aws-cdk-lib/aws-ram";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

export interface SharedResourcesStackProps extends cdk.StackProps {
  /** Root domain name, e.g. "example.com" */
  readonly rootDomain: string;
  /** Name for the cross-account Route 53 delegation IAM role */
  readonly delegationRoleName: string;
  /** Account IDs that are allowed to assume the delegation role */
  readonly trustedAccountIds: string[];
}

export class SharedResourcesStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: SharedResourcesStackProps) {
    super(scope, id, props);

    const { rootDomain, delegationRoleName, trustedAccountIds } = props;

    // ── Root Hosted Zone ──────────────────────────────────────────────

    this.hostedZone = new route53.PublicHostedZone(this, "RootHostedZone", {
      zoneName: rootDomain,
    });

    // ── Delegation Role ───────────────────────────────────────────────
    // Workload accounts assume this role to create sub-zone delegation
    // records and validate ACM certificates via DNS.

    const delegationRole = new iam.Role(this, "DelegationRole", {
      roleName: delegationRoleName,
      assumedBy: new iam.CompositePrincipal(
        ...trustedAccountIds.map(
          (accountId) => new iam.AccountPrincipal(accountId),
        ),
      ),
    });

    this.hostedZone.grantDelegation(delegationRole);

    delegationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
          "route53:GetHostedZone",
          "route53:GetChange",
        ],
        resources: [this.hostedZone.hostedZoneArn],
      }),
    );

    // ── SSM Parameters ────────────────────────────────────────────────
    // Workload stacks look these up to reference the hosted zone and role.

    const hostedZoneIdParam = new ssm.StringParameter(
      this,
      "HostedZoneIdParam",
      {
        parameterName: "/org-bootstrap/hosted-zone-id",
        stringValue: this.hostedZone.hostedZoneId,
        description: "Hosted zone ID for the root domain",
      },
    );

    const hostedZoneNameParam = new ssm.StringParameter(
      this,
      "HostedZoneNameParam",
      {
        parameterName: "/org-bootstrap/hosted-zone-name",
        stringValue: this.hostedZone.zoneName,
        description: "Hosted zone name for the root domain",
      },
    );

    const delegationRoleArnParam = new ssm.StringParameter(
      this,
      "DelegationRoleArnParam",
      {
        parameterName: "/org-bootstrap/delegation-role-arn",
        stringValue: delegationRole.roleArn,
        description: "ARN of the Route 53 delegation role",
      },
    );

    // ── RAM Share ─────────────────────────────────────────────────────
    // Share SSM parameters with workload accounts so they can look them
    // up at synth/deploy time.

    new ram.CfnResourceShare(this, "ParameterShare", {
      name: "org-bootstrap-shared-params",
      allowExternalPrincipals: false,
      principals: trustedAccountIds,
      resourceArns: [
        hostedZoneIdParam.parameterArn,
        hostedZoneNameParam.parameterArn,
        delegationRoleArnParam.parameterArn,
      ],
    });

    // ── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: this.hostedZone.hostedZoneId,
      description: "Root hosted zone ID.",
    });

    new cdk.CfnOutput(this, "DelegationRoleArn", {
      value: delegationRole.roleArn,
      description: "ARN of the cross-account delegation role.",
    });
  }
}
