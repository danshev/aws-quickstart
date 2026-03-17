import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface LogArchiveStackProps extends cdk.StackProps {
  readonly organizationId: string;
}

export class LogArchiveStack extends cdk.Stack {
  public readonly cloudTrailBucket: s3.Bucket;
  public readonly configBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: LogArchiveStackProps) {
    super(scope, id, props);

    const { organizationId } = props;

    // ── CloudTrail Log Bucket ────────────────────────────────────────

    this.cloudTrailBucket = new s3.Bucket(this, "CloudTrailLogs", {
      bucketName: `${this.account}-org-cloudtrail-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "GlacierTransition",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
          expiration: cdk.Duration.days(1000),
        },
      ],
    });

    this.cloudTrailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudTrailAclCheck",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("cloudtrail.amazonaws.com")],
        actions: ["s3:GetBucketAcl"],
        resources: [this.cloudTrailBucket.bucketArn],
        conditions: {
          StringEquals: {
            "aws:SourceOrgID": organizationId,
          },
        },
      }),
    );

    this.cloudTrailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudTrailWrite",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("cloudtrail.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [`${this.cloudTrailBucket.bucketArn}/AWSLogs/*`],
        conditions: {
          StringEquals: {
            "s3:x-amz-acl": "bucket-owner-full-control",
            "aws:SourceOrgID": organizationId,
          },
        },
      }),
    );

    // ── Config Snapshot Bucket (Phase 2 readiness) ───────────────────

    this.configBucket = new s3.Bucket(this, "ConfigSnapshots", {
      bucketName: `${this.account}-org-config-snapshots`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "GlacierTransition",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
          expiration: cdk.Duration.days(1000),
        },
      ],
    });

    // ── Outputs ──────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "CloudTrailBucketName", {
      value: this.cloudTrailBucket.bucketName,
      description: "S3 bucket for organization CloudTrail logs.",
    });

    new cdk.CfnOutput(this, "ConfigBucketName", {
      value: this.configBucket.bucketName,
      description: "S3 bucket for AWS Config snapshots (Phase 2).",
    });
  }
}
