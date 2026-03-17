import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ram from "aws-cdk-lib/aws-ram";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export interface NetworkHubStackProps extends cdk.StackProps {
  readonly egressVpcCidr: string;
  readonly spokeCidrs: string[];
  readonly trustedAccountIds: string[];
  readonly tgwAsn?: number;
}

export class NetworkHubStack extends cdk.Stack {
  /** Bypass the context-provider AZ lookup that Vpc triggers for validation. */
  get availabilityZones(): string[] {
    return [`${this.region}a`];
  }

  constructor(scope: Construct, id: string, props: NetworkHubStackProps) {
    super(scope, id, props);

    const {
      egressVpcCidr,
      spokeCidrs,
      trustedAccountIds,
      tgwAsn = 64512,
    } = props;

    // ── Transit Gateway ──────────────────────────────────────────────

    const tgw = new ec2.CfnTransitGateway(this, "TransitGateway", {
      amazonSideAsn: tgwAsn,
      autoAcceptSharedAttachments: "enable",
      defaultRouteTableAssociation: "disable",
      defaultRouteTablePropagation: "disable",
      tags: [{ key: "Name", value: "org-bootstrap-tgw" }],
    });

    // ── TGW Route Tables ─────────────────────────────────────────────

    const spokeRouteTable = new ec2.CfnTransitGatewayRouteTable(
      this,
      "SpokeRouteTable",
      {
        transitGatewayId: tgw.ref,
        tags: [{ key: "Name", value: "org-bootstrap-spoke-rt" }],
      },
    );

    const egressRouteTable = new ec2.CfnTransitGatewayRouteTable(
      this,
      "EgressRouteTable",
      {
        transitGatewayId: tgw.ref,
        tags: [{ key: "Name", value: "org-bootstrap-egress-rt" }],
      },
    );

    // ── Egress VPC ───────────────────────────────────────────────────

    const egressVpc = new ec2.Vpc(this, "EgressVpc", {
      ipAddresses: ec2.IpAddresses.cidr(egressVpcCidr),
      availabilityZones: [`${this.region}a`],
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "TgwAttachment",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ── TGW VPC Attachment (Egress VPC) ──────────────────────────────

    const tgwAttachmentSubnets = egressVpc.selectSubnets({
      subnetGroupName: "TgwAttachment",
    });

    const egressAttachment = new ec2.CfnTransitGatewayVpcAttachment(
      this,
      "EgressAttachment",
      {
        transitGatewayId: tgw.ref,
        vpcId: egressVpc.vpcId,
        subnetIds: tgwAttachmentSubnets.subnetIds,
        tags: [{ key: "Name", value: "org-bootstrap-egress-attachment" }],
      },
    );

    // ── Associate Egress Attachment with Egress Route Table ──────────

    const egressRtAssociation = new ec2.CfnTransitGatewayRouteTableAssociation(
      this,
      "EgressRtAssociation",
      {
        transitGatewayAttachmentId: egressAttachment.ref,
        transitGatewayRouteTableId: egressRouteTable.ref,
      },
    );

    // ── Enable TGW Default Association / Propagation ───────────────
    // Spoke VPC attachments (from workload accounts) are auto-associated
    // with the spoke route table and auto-propagated to the egress route
    // table.  This runs AFTER the egress attachment is explicitly
    // associated so that the egress attachment keeps its own association.

    const tgwDefaultsCall: cr.AwsSdkCall = {
      service: "EC2",
      action: "modifyTransitGateway",
      parameters: {
        TransitGatewayId: tgw.ref,
        Options: {
          DefaultRouteTableAssociation: "enable",
          AssociationDefaultRouteTableId: spokeRouteTable.ref,
          DefaultRouteTablePropagation: "enable",
          PropagationDefaultRouteTableId: egressRouteTable.ref,
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of("tgw-defaults"),
    };

    const tgwDefaults = new cr.AwsCustomResource(this, "TgwDefaults", {
      onCreate: tgwDefaultsCall,
      onUpdate: tgwDefaultsCall,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    tgwDefaults.node.addDependency(egressRtAssociation);

    // ── Spoke Route Table: default route → Egress Attachment ─────────

    new ec2.CfnTransitGatewayRoute(this, "SpokeDefaultRoute", {
      transitGatewayRouteTableId: spokeRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      transitGatewayAttachmentId: egressAttachment.ref,
    });

    // ── Public Subnet Routes: spoke CIDRs → TGW (return traffic) ────

    const publicSubnets = egressVpc.selectSubnets({
      subnetGroupName: "Public",
    });

    for (const [i, spokeCidr] of spokeCidrs.entries()) {
      new ec2.CfnRoute(this, `SpokeReturnRoute${i}`, {
        routeTableId: publicSubnets.subnetIds.length
          ? publicSubnets.subnets[0].routeTable.routeTableId
          : "",
        destinationCidrBlock: spokeCidr,
        transitGatewayId: tgw.ref,
      }).addDependency(egressAttachment);
    }

    // ── RAM Share (TGW → workload accounts) ──────────────────────────

    new ram.CfnResourceShare(this, "TgwShare", {
      name: "org-bootstrap-tgw-share",
      allowExternalPrincipals: false,
      principals: trustedAccountIds,
      resourceArns: [
        `arn:aws:ec2:${this.region}:${this.account}:transit-gateway/${tgw.ref}`,
      ],
    });

    // ── SSM Parameters ───────────────────────────────────────────────

    new ssm.StringParameter(this, "TgwIdParam", {
      parameterName: "/org-bootstrap/tgw-id",
      stringValue: tgw.ref,
      description: "Transit Gateway ID",
    });

    new ssm.StringParameter(this, "SpokeRtIdParam", {
      parameterName: "/org-bootstrap/spoke-rt-id",
      stringValue: spokeRouteTable.ref,
      description: "TGW Spoke Route Table ID",
    });

    new ssm.StringParameter(this, "EgressRtIdParam", {
      parameterName: "/org-bootstrap/egress-rt-id",
      stringValue: egressRouteTable.ref,
      description: "TGW Egress Route Table ID",
    });

    // ── Cross-Account SSM Reader Role ─────────────────────────────────
    // Spoke accounts assume this role to read the SSM parameters above,
    // because RAM-shared TGW resources don't expose the owner's tags
    // cross-account (so tag-based discovery doesn't work from spokes).

    const ssmReaderRole = new iam.Role(this, "SpokeSsmReaderRole", {
      roleName: "org-bootstrap-spoke-ssm-reader",
      assumedBy: new iam.CompositePrincipal(
        ...trustedAccountIds.map((id) => new iam.AccountPrincipal(id)),
      ),
    });
    ssmReaderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/org-bootstrap/*`,
        ],
      }),
    );

    // ── Outputs ──────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "TransitGatewayId", {
      value: tgw.ref,
      description: "Transit Gateway ID.",
    });

    new cdk.CfnOutput(this, "EgressVpcId", {
      value: egressVpc.vpcId,
      description: "Egress VPC ID.",
    });
  }
}
