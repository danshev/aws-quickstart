import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import type { Construct } from "constructs";
import type { ServiceBudgetAlert } from "../../../config/schema";

export interface ServiceBudgetsStackProps extends cdk.StackProps {
  /** Email address to notify when cost thresholds are crossed. */
  readonly alertEmail: string;
  /** Deployment stage name (e.g. "dev", "prod"). Used in budget names. */
  readonly stageName: string;
  /** One or more service-level monthly cost budgets to create. */
  readonly serviceBudgets: ServiceBudgetAlert[];
}

const toPascalCase = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const toKebabCase = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export class ServiceBudgetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServiceBudgetsStackProps) {
    super(scope, id, props);

    const { alertEmail, stageName, serviceBudgets } = props;

    for (const alert of serviceBudgets) {
      new budgets.CfnBudget(this, `${toPascalCase(alert.service)}Budget`, {
        budget: {
          budgetName: `${stageName}-${toKebabCase(alert.service)}-budget`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: alert.monthlyThresholdUsd,
            unit: "USD",
          },
          costFilters: {
            Service: [alert.service],
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
            subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }],
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }],
          },
        ],
      });
    }
  }
}
