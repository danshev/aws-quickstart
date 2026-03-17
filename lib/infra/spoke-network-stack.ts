import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export interface SpokeNetworkStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly spokeCidr: string;
  readonly sharedServicesAccountId: string;
}

export class SpokeNetworkStack extends cdk.Stack {
  /** Bypass the context-provider AZ lookup that Vpc triggers for validation. */
  get availabilityZones(): string[] {
    return [`${this.region}a`];
  }

  constructor(scope: Construct, id: string, props: SpokeNetworkStackProps) {
    super(scope, id, props);

    const { stageName, spokeCidr } = props;

    // ── Look up TGW and route table IDs from hub account SSM params ──
    // RAM-shared TGW resources don't expose the owner's tags cross-account,
    // so we assume a role in the shared services account and read SSM
    // parameters that the NetworkHub stack writes at deploy time.

    const ssmReaderRoleArn = `arn:aws:iam::${props.sharedServicesAccountId}:role/org-bootstrap-spoke-ssm-reader`;

    const lookupFn = new lambda.Function(this, "TgwLookupFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      environment: {
        SSM_READER_ROLE_ARN: ssmReaderRoleArn,
      },
      code: lambda.Code.fromInline(`
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
exports.handler = async (event) => {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId || "tgw-lookup" };
  const sts = new STSClient();
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: process.env.SSM_READER_ROLE_ARN,
    RoleSessionName: "spoke-tgw-lookup",
  }));
  const creds = assumed.Credentials;
  const ssm = new SSMClient({ credentials: {
    accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken,
  }});
  const tgwId = (await ssm.send(new GetParameterCommand({ Name: "/org-bootstrap/tgw-id" }))).Parameter.Value;
  return { PhysicalResourceId: "tgw-lookup", Data: { TgwId: tgwId } };
};
      `),
    });

    lookupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [ssmReaderRoleArn],
      }),
    );

    const tgwLookupProvider = new cr.Provider(this, "TgwLookupProvider", {
      onEventHandler: lookupFn,
    });

    const tgwLookup = new cdk.CustomResource(this, "TgwLookup", {
      serviceToken: tgwLookupProvider.serviceToken,
    });

    const tgwId = tgwLookup.getAttString("TgwId");

    // ── Spoke VPC ────────────────────────────────────────────────────

    const spokeVpc = new ec2.Vpc(this, "SpokeVpc", {
      ipAddresses: ec2.IpAddresses.cidr(spokeCidr),
      availabilityZones: [`${this.region}a`],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ── TGW VPC Attachment ───────────────────────────────────────────

    const privateSubnets = spokeVpc.selectSubnets({
      subnetGroupName: "Private",
    });

    const spokeAttachment = new ec2.CfnTransitGatewayVpcAttachment(
      this,
      "SpokeAttachment",
      {
        transitGatewayId: tgwId,
        vpcId: spokeVpc.vpcId,
        subnetIds: privateSubnets.subnetIds,
        tags: [{ key: "Name", value: `org-bootstrap-spoke-${stageName}` }],
      },
    );

    // RT association (spoke RT) and propagation (egress RT) are handled
    // automatically by the TGW's default route table settings configured
    // in the NetworkHub stack.

    // ── Default Route: 0.0.0.0/0 → TGW ──────────────────────────────

    for (const subnet of privateSubnets.subnets) {
      new ec2.CfnRoute(this, `DefaultRoute${subnet.node.id}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        transitGatewayId: tgwId,
      }).addDependency(spokeAttachment);
    }

    // ── VPC Endpoints for SSM ────────────────────────────────────────

    const endpointSg = new ec2.SecurityGroup(this, "VpcEndpointSg", {
      vpc: spokeVpc,
      description: "Allow HTTPS from VPC CIDR for SSM endpoints",
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(
      ec2.Peer.ipv4(spokeCidr),
      ec2.Port.tcp(443),
      "HTTPS from VPC",
    );

    for (const svc of ["ssm", "ssmmessages", "ec2messages"]) {
      new ec2.InterfaceVpcEndpoint(this, `${svc}Endpoint`, {
        vpc: spokeVpc,
        service: new ec2.InterfaceVpcEndpointService(
          `com.amazonaws.${this.region}.${svc}`,
        ),
        subnets: { subnetGroupName: "Private" },
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }

    // ── EC2 Demo Instance ────────────────────────────────────────────

    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    const instance = new ec2.Instance(this, "DemoInstance", {
      vpc: spokeVpc,
      vpcSubnets: { subnetGroupName: "Private" },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
      ),
      role: instanceRole,
      requireImdsv2: true,
    });

    // ── Outputs ──────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.instanceId,
      description: `EC2 instance ID (${stageName}).`,
    });

    new cdk.CfnOutput(this, "PrivateIp", {
      value: instance.instancePrivateIp,
      description: `EC2 private IP (${stageName}).`,
    });

    new cdk.CfnOutput(this, "SsmConnectCommand", {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: "SSM Session Manager connect command.",
    });
  }
}
