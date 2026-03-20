import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { AppStageProps } from "../app-stage-props";
import { AppResourcesStack } from "./stacks/app-resources-stack";
import { ServiceBudgetsStack } from "./stacks/service-budgets-stack";
import { SpokeNetworkStack } from "../infra/spoke-network-stack";

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export class AppStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    new AppResourcesStack(
      this,
      `${toPascalCase(props.stageName)}TestappAppResources`,
      {
        stageName: props.stageName,
        env: props.env,
      },
    );

    if (props.deploymentTarget.spokeCidr) {
      new SpokeNetworkStack(
        this,
        `${toPascalCase(props.stageName)}SpokeNetwork`,
        {
          stageName: props.stageName,
          spokeCidr: props.deploymentTarget.spokeCidr,
          sharedServicesAccountId: props.sharedServicesAccountId ?? "",
          env: props.env,
        },
      );
    }

    if (props.appConfig.alertEmail && props.deploymentTarget.serviceBudgets?.length) {
      new ServiceBudgetsStack(
        this,
        `${toPascalCase(props.stageName)}ServiceBudgets`,
        {
          alertEmail: props.appConfig.alertEmail,
          serviceBudgets: props.deploymentTarget.serviceBudgets,
          stageName: props.stageName,
          env: props.env,
        },
      );
    }
  }
}
