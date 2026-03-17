import type * as cdk from "aws-cdk-lib";
import type { AppConfig, DeploymentTarget } from "../config/schema";

export interface AppStageProps extends cdk.StageProps {
  readonly stageName: string;
  readonly tags?: Record<string, string>;
  readonly appConfig: AppConfig;
  readonly deploymentTarget: DeploymentTarget;
  readonly sharedServicesAccountId?: string;
}
