import * as cdk from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface OrgCloudTrailStackProps extends cdk.StackProps {
  /** The S3 bucket ARN in the Log Archive account for CloudTrail logs. */
  readonly cloudTrailBucketArn: string;
}

export class OrgCloudTrailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OrgCloudTrailStackProps) {
    super(scope, id, props);

    const trailBucket = s3.Bucket.fromBucketArn(
      this,
      "CloudTrailBucket",
      props.cloudTrailBucketArn,
    );

    new cloudtrail.Trail(this, "OrgTrail", {
      trailName: "org-trail",
      bucket: trailBucket,
      isOrganizationTrail: true,
      isMultiRegionTrail: true,
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    });

    new cdk.CfnOutput(this, "TrailName", {
      value: "org-trail",
      description: "Organization-level CloudTrail trail name.",
    });
  }
}
