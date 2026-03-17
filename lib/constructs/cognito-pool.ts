import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

export interface CognitoPoolProps {
  readonly stageName: string;
  readonly selfSignUpEnabled?: boolean;
  readonly passwordMinLength?: number;
}

export class CognitoPool extends cdk.Resource {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoPoolProps) {
    super(scope, id);

    const isProd = props.stageName === "prod";
    const selfSignUpEnabled = props.selfSignUpEnabled ?? true;
    const passwordMinLength = props.passwordMinLength ?? 8;

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${props.stageName}-graphql-userpool`,
      selfSignUpEnabled,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: passwordMinLength,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient("AppClient", {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      accessTokenValidity: cdk.Duration.hours(12),
      idTokenValidity: cdk.Duration.hours(12),
      refreshTokenValidity: cdk.Duration.days(30),
    });
  }
}
