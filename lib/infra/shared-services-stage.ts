import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { DomainConfig } from "../../config/schema";
import { NetworkHubStack } from "./network-hub-stack";
import { SharedResourcesStack } from "./shared-resources-stack";

export interface SharedServicesStageProps extends cdk.StageProps {
  readonly domainConfig?: DomainConfig;
  readonly egressVpcCidr?: string;
  readonly spokeCidrs?: string[];
  readonly tgwAsn?: number;
  readonly trustedAccountIds: string[];
}

export class SharedServicesStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: SharedServicesStageProps) {
    super(scope, id, props);

    if (props.domainConfig) {
      new SharedResourcesStack(this, "SharedResources", {
        rootDomain: props.domainConfig.rootDomain,
        delegationRoleName: props.domainConfig.delegationRoleName,
        trustedAccountIds: props.trustedAccountIds,
        env: props.env,
      });
    }

    if (props.egressVpcCidr) {
      new NetworkHubStack(this, "NetworkHub", {
        egressVpcCidr: props.egressVpcCidr,
        spokeCidrs: props.spokeCidrs ?? [],
        trustedAccountIds: props.trustedAccountIds,
        tgwAsn: props.tgwAsn,
        env: props.env,
      });
    }
  }
}
