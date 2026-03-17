import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export interface BudgetAlertsStackProps extends cdk.StackProps {
  /** Email address for budget and cost anomaly alerts. */
  readonly alertEmail: string;
  /** Monthly cost budget in USD. */
  readonly monthlyBudgetUsd: number;
}

export class BudgetAlertsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BudgetAlertsStackProps) {
    super(scope, id, props);

    const { alertEmail, monthlyBudgetUsd } = props;

    // ── SNS Topic ────────────────────────────────────────────────────

    const alertTopic = new sns.Topic(this, "BudgetAlertsTopic", {
      topicName: "org-budget-alerts",
      displayName: "Organization Budget Alerts",
    });

    alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));

    // ── Monthly Cost Budget ──────────────────────────────────────────

    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: "org-monthly-cost-budget",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: monthlyBudgetUsd,
          unit: "USD",
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            {
              subscriptionType: "SNS",
              address: alertTopic.topicArn,
            },
          ],
        },
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            {
              subscriptionType: "SNS",
              address: alertTopic.topicArn,
            },
          ],
        },
      ],
    });

    // ── Cost Anomaly Detection ───────────────────────────────────────

    const anomalyMonitor = new ce.CfnAnomalyMonitor(this, "AnomalyMonitor", {
      monitorName: "org-service-anomaly-monitor",
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });

    new ce.CfnAnomalySubscription(this, "AnomalySubscription", {
      subscriptionName: "org-anomaly-alerts",
      frequency: "IMMEDIATE",
      monitorArnList: [anomalyMonitor.attrMonitorArn],
      subscribers: [
        {
          type: "SNS",
          address: alertTopic.topicArn,
        },
      ],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: ["50"],
        },
      }),
    });

    // Allow Cost Explorer to publish to SNS.
    alertTopic.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: "AllowCostExplorerPublish",
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [
          new cdk.aws_iam.ServicePrincipal("costalerts.amazonaws.com"),
        ],
        actions: ["sns:Publish"],
        resources: [alertTopic.topicArn],
      }),
    );

    // Allow Budgets to publish to SNS.
    alertTopic.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: "AllowBudgetsPublish",
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [alertTopic.topicArn],
      }),
    );

    // ── Outputs ──────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "AlertTopicArn", {
      value: alertTopic.topicArn,
      description: "SNS topic ARN for budget and cost anomaly alerts.",
    });
  }
}
