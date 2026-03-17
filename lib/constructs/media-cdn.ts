import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface MediaCdnProps {
  /** Stage name, e.g. "dev" or "prod" */
  readonly stageName: string;
  /** Full stage domain, e.g. "dev.example.com" or "example.com" */
  readonly stageDomain: string;
  /** Root domain name that the Shared Services hosted zone manages */
  readonly rootDomain: string;
  /** Shared Services account ID (owns the root hosted zone) */
  readonly sharedServicesAccountId: string;
  /** Name of the delegation IAM role in Shared Services */
  readonly delegationRoleName: string;
  /** The S3 bucket to serve media from */
  readonly mediaBucket: s3.IBucket;
}

/**
 * Creates a CloudFront distribution fronting an S3 bucket, with a custom
 * domain under `media.{stageDomain}`.
 *
 * Handles:
 *  - Sub-hosted zone for the media subdomain
 *  - Cross-account delegation back to the root hosted zone
 *  - ACM certificate validated via DNS
 *  - CloudFront distribution with OAC
 *  - A + AAAA alias records
 *  - Access log bucket
 */
export class MediaCdn extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly mediaDomain: string;
  public readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MediaCdnProps) {
    super(scope, id);

    const {
      stageName,
      stageDomain,
      rootDomain,
      sharedServicesAccountId,
      delegationRoleName,
      mediaBucket,
    } = props;

    this.mediaDomain = `media.${stageDomain}`;

    // ── Sub-Hosted Zone ───────────────────────────────────────────────

    const mediaHostedZone = new route53.PublicHostedZone(
      this,
      "MediaHostedZone",
      { zoneName: this.mediaDomain },
    );

    const delegationRole = iam.Role.fromRoleArn(
      this,
      "DelegationRole",
      `arn:aws:iam::${sharedServicesAccountId}:role/${delegationRoleName}`,
    );

    const delegation = new route53.CrossAccountZoneDelegationRecord(
      this,
      "MediaDelegate",
      {
        delegatedZone: mediaHostedZone,
        parentHostedZoneName: rootDomain,
        delegationRole,
      },
    );

    // ── ACM Certificate ───────────────────────────────────────────────

    const certificate = new acm.Certificate(this, "MediaCert", {
      domainName: this.mediaDomain,
      validation: acm.CertificateValidation.fromDns(mediaHostedZone),
    });
    certificate.node.addDependency(delegation);

    new route53.CaaRecord(this, "MediaCaaRecord", {
      zone: mediaHostedZone,
      values: [
        {
          flag: 0,
          tag: route53.CaaTag.ISSUE,
          value: "amazon.com",
        },
        {
          flag: 0,
          tag: route53.CaaTag.ISSUEWILD,
          value: "amazon.com",
        },
      ],
    });

    // ── Access Log Bucket ─────────────────────────────────────────────

    this.logBucket = new s3.Bucket(this, "MediaLogsBucket", {
      removalPolicy:
        stageName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stageName !== "prod",
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      versioned: stageName === "prod",
    });

    // ── CloudFront Distribution ───────────────────────────────────────

    this.distribution = new cloudfront.Distribution(this, "MediaDistribution", {
      domainNames: [this.mediaDomain],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy
            .CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `Media CDN (${stageName})`,
      enableLogging: true,
      logBucket: this.logBucket,
      logFilePrefix: "cloudfront/",
    });

    // ── DNS Records ───────────────────────────────────────────────────

    new route53.ARecord(this, "MediaAliasARecord", {
      zone: mediaHostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
    });

    new route53.AaaaRecord(this, "MediaAliasAAAARecord", {
      zone: mediaHostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
    });

    // ── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "MediaBaseUrl", {
      value: `https://${this.mediaDomain}/`,
      description: "Base URL for media assets.",
    });

    new cdk.CfnOutput(this, "MediaCloudFrontDomainName", {
      value: this.distribution.distributionDomainName,
      description: "CloudFront distribution domain name.",
    });

    new cdk.CfnOutput(this, "MediaDistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront distribution ID.",
    });
  }
}
