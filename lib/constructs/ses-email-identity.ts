import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import { Construct } from "constructs";

export interface SesEmailIdentityProps {
  /** Stage name, e.g. "dev" or "prod" */
  readonly stageName: string;
  /** Full stage domain, e.g. "dev.example.com" or "example.com" */
  readonly stageDomain: string;
  /** The hosted zone for the stage domain */
  readonly stageHostedZone: route53.IPublicHostedZone;
  /** Optional email for DMARC aggregate reports. When omitted, the DMARC record uses p=quarantine with no rua. */
  readonly dmarcReportEmail?: string;
}

/**
 * Creates an SES domain identity with DKIM and a custom MAIL FROM domain.
 *
 * Handles:
 *  - SES EmailIdentity with automatic DKIM DNS records
 *  - Custom MAIL FROM domain (mail.{stageDomain})
 *  - MX record for MAIL FROM domain
 *  - SPF TXT record for MAIL FROM domain
 */
export class SesEmailIdentity extends Construct {
  public readonly senderAddress: string;
  public readonly emailIdentity: ses.EmailIdentity;
  public readonly configurationSetName: string;

  constructor(scope: Construct, id: string, props: SesEmailIdentityProps) {
    super(scope, id);

    const { stageName, stageDomain, stageHostedZone } = props;

    this.senderAddress = `no-reply@${stageDomain}`;
    const mailFromDomain = `mail.${stageDomain}`;

    // ── SES Configuration Set ─────────────────────────────────────────
    const configSet = new ses.ConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: `${stageName}-email-config`,
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSetName = configSet.configurationSetName;

    // ── SES Email Identity ─────────────────────────────────────────────
    this.emailIdentity = new ses.EmailIdentity(this, "EmailIdentity", {
      identity: ses.Identity.publicHostedZone(stageHostedZone),
      mailFromDomain,
      configurationSet: configSet,
    });

    // ── MAIL FROM DNS Records ──────────────────────────────────────────
    new route53.MxRecord(this, "MailFromMx", {
      zone: stageHostedZone,
      recordName: mailFromDomain,
      values: [
        {
          priority: 10,
          hostName: `feedback-smtp.${cdk.Stack.of(this).region}.amazonses.com`,
        },
      ],
    });

    new route53.TxtRecord(this, "MailFromSpf", {
      zone: stageHostedZone,
      recordName: mailFromDomain,
      values: ["v=spf1 include:amazonses.com ~all"],
    });

    // ── DMARC Record ──────────────────────────────────────────────────
    const dmarcValue = props.dmarcReportEmail
      ? `v=DMARC1; p=quarantine; rua=mailto:${props.dmarcReportEmail}`
      : "v=DMARC1; p=quarantine";

    new route53.TxtRecord(this, "Dmarc", {
      zone: stageHostedZone,
      recordName: `_dmarc.${stageDomain}`,
      values: [dmarcValue],
    });

    // ── Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "SesSenderAddress", {
      value: this.senderAddress,
      description: "SES sender email address.",
    });
  }
}
