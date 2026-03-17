import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface DomainProps {
  readonly domainConfig: {
    readonly rootDomain: string;
    readonly delegationRoleName: string;
  };
  readonly stageDomain: string;
  readonly sharedServicesAccountId: string;
}

export interface AppResourcesStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly domainProps?: DomainProps;
}

export class AppResourcesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppResourcesStackProps) {
    super(scope, id, props);

    new s3.Bucket(this, "MediaBucket", {
      bucketName: `testapp-media-${props.stageName}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
