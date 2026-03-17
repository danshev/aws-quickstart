import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { SesEmailIdentity } from "../lib/constructs/ses-email-identity";

const defaultEnv = { account: "222222222222", region: "us-east-1" };

function createTemplate(stageName = "dev", stageDomain = "dev.example.com") {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", { env: defaultEnv });
  const zone = new route53.PublicHostedZone(stack, "Zone", {
    zoneName: stageDomain,
  });

  const ses = new SesEmailIdentity(stack, "Ses", {
    stageName,
    stageDomain,
    stageHostedZone: zone,
  });

  return { template: Template.fromStack(stack), ses };
}

test("SES EmailIdentity is created", () => {
  const { template } = createTemplate();
  template.resourceCountIs("AWS::SES::EmailIdentity", 1);
});

test("MAIL FROM MX record points to SES feedback SMTP", () => {
  const { template } = createTemplate();
  template.hasResourceProperties("AWS::Route53::RecordSet", {
    Type: "MX",
    Name: "mail.dev.example.com.",
    ResourceRecords: [
      Match.stringLikeRegexp("10 feedback-smtp\\..*\\.amazonses\\.com"),
    ],
  });
});

test("SPF TXT record is created for MAIL FROM domain", () => {
  const { template } = createTemplate();
  template.hasResourceProperties("AWS::Route53::RecordSet", {
    Type: "TXT",
    Name: "mail.dev.example.com.",
  });
});

test("DMARC TXT record is created", () => {
  const { template } = createTemplate();
  template.hasResourceProperties("AWS::Route53::RecordSet", {
    Type: "TXT",
    Name: "_dmarc.dev.example.com.",
  });
});

test("SES Configuration Set is created with reputation metrics", () => {
  const { template } = createTemplate();
  template.hasResourceProperties("AWS::SES::ConfigurationSet", {
    Name: "dev-email-config",
    ReputationOptions: { ReputationMetricsEnabled: true },
    SuppressionOptions: {
      SuppressedReasons: ["BOUNCE", "COMPLAINT"],
    },
  });
});

test("configurationSetName is exposed", () => {
  const { ses } = createTemplate();
  assert.ok(ses.configurationSetName, "configurationSetName should be set");
});

test("senderAddress is correctly set", () => {
  const { ses } = createTemplate();
  assert.equal(ses.senderAddress, "no-reply@dev.example.com");
});

test("prod stage sets correct sender address", () => {
  const { ses } = createTemplate("prod", "example.com");
  assert.equal(ses.senderAddress, "no-reply@example.com");
});

test("SesSenderAddress output exists", () => {
  const { template } = createTemplate();
  const outputs = template.toJSON().Outputs;
  assert.ok(outputs, "Stack should have outputs");
  const outputKeys = Object.keys(outputs);
  const hasSenderOutput = outputKeys.some((k) =>
    k.includes("SesSenderAddress"),
  );
  assert.ok(hasSenderOutput, "SesSenderAddress output should exist");
});
