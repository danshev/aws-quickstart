import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NetworkHubStack } from "../lib/infra/network-hub-stack";

const defaultProps = {
  egressVpcCidr: "10.0.0.0/16",
  spokeCidrs: ["10.1.0.0/16", "10.2.0.0/16"],
  trustedAccountIds: ["222222222222", "333333333333"],
  tgwAsn: 64512,
  env: { account: "111111111111", region: "us-east-1" },
};

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new NetworkHubStack(app, "TestNetworkHub", defaultProps);
  return Template.fromStack(stack);
}

test("Transit Gateway is created with correct ASN and auto-accept", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::EC2::TransitGateway", {
    AmazonSideAsn: 64512,
    AutoAcceptSharedAttachments: "enable",
  });
});

test("two TGW route tables are created", () => {
  const template = createTemplate();
  template.resourceCountIs("AWS::EC2::TransitGatewayRouteTable", 2);
});

test("Egress VPC is created with expected subnets", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::EC2::VPC", {
    CidrBlock: "10.0.0.0/16",
  });
  // Public + TgwAttachment subnets
  template.resourceCountIs("AWS::EC2::Subnet", 2);
  // NAT Gateway
  template.resourceCountIs("AWS::EC2::NatGateway", 1);
});

test("RAM share includes correct principals", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::RAM::ResourceShare", {
    Name: "org-bootstrap-tgw-share",
    Principals: ["222222222222", "333333333333"],
  });
});

test("spoke return routes exist for each spoke CIDR", () => {
  const template = createTemplate();
  const routes = template.findResources("AWS::EC2::Route");
  const spokeCidrRoutes = Object.values(routes).filter(
    (r) =>
      (r as { Properties: { DestinationCidrBlock: string } }).Properties
        .DestinationCidrBlock === "10.1.0.0/16" ||
      (r as { Properties: { DestinationCidrBlock: string } }).Properties
        .DestinationCidrBlock === "10.2.0.0/16",
  );
  assert.equal(spokeCidrRoutes.length, 2);
});

test("SSM parameters are created", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/org-bootstrap/tgw-id",
  });
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/org-bootstrap/spoke-rt-id",
  });
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/org-bootstrap/egress-rt-id",
  });
});
