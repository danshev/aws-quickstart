import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SpokeNetworkStack } from "../lib/infra/spoke-network-stack";

const defaultProps = {
  stageName: "dev",
  spokeCidr: "10.1.0.0/16",
  sharedServicesAccountId: "111111111111",
  env: { account: "222222222222", region: "us-east-1" },
};

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new SpokeNetworkStack(app, "TestSpokeNetwork", defaultProps);
  return Template.fromStack(stack);
}

test("spoke VPC has no NAT Gateway or Internet Gateway", () => {
  const template = createTemplate();
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::InternetGateway", 0);
});

test("EC2 instance has SSM managed policy and IMDSv2 required", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::IAM::Role", {
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        "Fn::Join": Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp("AmazonSSMManagedInstanceCore"),
          ]),
        ]),
      }),
    ]),
  });
  // CDK sets IMDSv2 via a LaunchTemplate when requireImdsv2 is true
  template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
    LaunchTemplateData: {
      MetadataOptions: {
        HttpTokens: "required",
      },
    },
  });
});

test("three SSM VPC endpoints are created", () => {
  const template = createTemplate();
  const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
  const interfaceEndpoints = Object.values(endpoints).filter(
    (e) =>
      (e as { Properties: { VpcEndpointType?: string } }).Properties
        .VpcEndpointType === "Interface" ||
      !(e as { Properties: { VpcEndpointType?: string } }).Properties
        .VpcEndpointType,
  );
  assert.equal(interfaceEndpoints.length, 3);
});

test("default route 0.0.0.0/0 points to TGW", () => {
  const template = createTemplate();
  const routes = template.findResources("AWS::EC2::Route");
  const defaultRoutes = Object.values(routes).filter(
    (r) =>
      (r as { Properties: { DestinationCidrBlock: string } }).Properties
        .DestinationCidrBlock === "0.0.0.0/0",
  );
  assert.ok(defaultRoutes.length >= 1, "Expected at least one default route");
  for (const route of defaultRoutes) {
    assert.ok(
      (route as { Properties: { TransitGatewayId: unknown } }).Properties
        .TransitGatewayId,
      "Default route should point to TGW",
    );
  }
});
