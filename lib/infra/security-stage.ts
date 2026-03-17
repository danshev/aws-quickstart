import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { SecurityConfig } from "../../config/schema";
import { BudgetAlertsStack } from "./budget-alerts-stack";
import { LogArchiveStack } from "./log-archive-stack";
// import { OrgCloudTrailStack } from "./org-cloudtrail-stack";

export interface SecurityStageProps extends cdk.StageProps {
  readonly securityConfig: SecurityConfig;
  readonly sharedServicesAccountId: string;
  readonly organizationId: string;
}

export class SecurityStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: SecurityStageProps) {
    super(scope, id, props);

    const { securityConfig, sharedServicesAccountId, organizationId } = props;
    const region = props.env?.region ?? "us-east-1";

    // ── Log Archive Stack (deployed to Log Archive account) ─────────

    const logArchiveStack = new LogArchiveStack(this, "LogArchive", {
      organizationId,
      env: {
        account: securityConfig.logArchiveAccountId,
        region,
      },
    });

    // ── Org CloudTrail Stack (deployed to Shared Services account) ──
    // DISABLED: Deploying the org trail requires CDK-bootstrapping the
    // management account, which is currently blocked. Re-enable once
    // that dependency is resolved.
    //
    // const cloudTrailStack = new OrgCloudTrailStack(this, "OrgCloudTrail", {
    //   cloudTrailBucketArn: `arn:aws:s3:::${securityConfig.logArchiveAccountId}-org-cloudtrail-logs`,
    //   env: {
    //     account: sharedServicesAccountId,
    //     region,
    //   },
    // });
    // cloudTrailStack.addDependency(logArchiveStack);

    // ── Budget Alerts Stack (deployed to Shared Services account) ───

    if (securityConfig.alertEmail) {
      new BudgetAlertsStack(this, "BudgetAlerts", {
        alertEmail: securityConfig.alertEmail,
        monthlyBudgetUsd: securityConfig.monthlyBudgetUsd ?? 1000,
        env: {
          account: sharedServicesAccountId,
          region,
        },
      });
    }
  }
}
