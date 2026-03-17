import * as cdk from "aws-cdk-lib";
import {
  type AttributeType,
  BillingMode,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export { AttributeType } from "aws-cdk-lib/aws-dynamodb";

export interface TableDefinition {
  partitionKey: { name: string; type: AttributeType };
  sortKey?: { name: string; type: AttributeType };
  timeToLiveAttribute?: string;
  globalSecondaryIndexes?: {
    indexName: string;
    partitionKey: { name: string; type: AttributeType };
    sortKey?: { name: string; type: AttributeType };
  }[];
}

export interface DynamoDbTablesProps<T extends string> {
  disambiguator: string;
  terminationProtection?: boolean;
  tables: Record<T, TableDefinition>;
}

export class DynamoDbTables<T extends string> extends Construct {
  public readonly tableMap: Record<T, Table>;

  constructor(scope: Construct, id: string, props: DynamoDbTablesProps<T>) {
    super(scope, id);

    const { disambiguator, tables } = props;
    const isProd = disambiguator === "prod";
    const removalPolicy = isProd
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;
    const deletionProtection = props.terminationProtection ?? isProd;

    this.tableMap = {} as Record<T, Table>;

    for (const [tableName, def] of Object.entries<TableDefinition>(tables)) {
      const table = new Table(this, tableName, {
        tableName: `${tableName}-${disambiguator}`,
        partitionKey: def.partitionKey,
        sortKey: def.sortKey,
        billingMode: BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: isProd,
        },
        removalPolicy,
        deletionProtection,
        timeToLiveAttribute: def.timeToLiveAttribute,
      });

      if (def.globalSecondaryIndexes) {
        for (const gsi of def.globalSecondaryIndexes) {
          table.addGlobalSecondaryIndex({
            indexName: gsi.indexName,
            partitionKey: gsi.partitionKey,
            sortKey: gsi.sortKey,
          });
        }
      }

      new cdk.CfnOutput(this, `${tableName}TableName`, {
        value: table.tableName,
        exportName: `${tableName}TableName-${disambiguator}`,
      });

      this.tableMap[tableName as T] = table;
    }
  }
}
