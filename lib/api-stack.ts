import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { grantInferenceProfile } from "./bedrock-access";
import type { OpexConfig } from "./config";

export interface ApiStackProps extends StackProps {
  readonly config: OpexConfig;
}

// Signed-in OpEx Agent backend:
// - an app client in the shared T4Tangerine Cognito user pool
// - an HTTP API whose routes all require a valid Cognito ID token
// - a plans table keyed by the token's user id, so users only ever see their own
// - an async worker, because a plan takes ~25 s and the HTTP API stops at 30 s
export class ApiStack extends Stack {
  readonly apiUrl: string;
  readonly userPoolClientId: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;
    Tags.of(this).add("app", config.appName);

    // ── Sign-in: this app's client in the shared user pool ──
    const userPool = cognito.UserPool.fromUserPoolId(this, "SharedUserPool", config.auth.userPoolId);
    const callbackUrls = [config.appUrl, ...config.devOrigins].map((o) => `${o}/`);
    const client = new cognito.UserPoolClient(this, "WebClient", {
      userPool,
      userPoolClientName: `${config.appName}Web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    // The managed login page needs a style for every client that uses it
    new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: config.auth.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    this.userPoolClientId = client.userPoolClientId;

    // ── Data ──
    const plans = new dynamodb.Table(this, "Plans", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "planId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // users' saved plans
    });
    const quotas = new dynamodb.Table(this, "Quotas", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY, // only short-lived counters
    });

    // ── Functions ──
    const fn = (name: string, entry: string, extra: Partial<NodejsFunctionProps>) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, "..", "lambda", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        tracing: lambda.Tracing.ACTIVE,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: true },
        ...extra,
      });

    const worker = fn("Worker", "worker.ts", {
      timeout: Duration.seconds(120),
      retryAttempts: 1,
      environment: { PLANS_TABLE: plans.tableName, MODEL_ID: config.modelId },
    });
    plans.grant(worker, "dynamodb:GetItem", "dynamodb:UpdateItem");
    grantInferenceProfile(worker, this, config.modelId);

    const api = fn("PlansApi", "plans.ts", {
      timeout: Duration.seconds(10),
      environment: {
        PLANS_TABLE: plans.tableName,
        QUOTA_TABLE: quotas.tableName,
        WORKER_FUNCTION: worker.functionName,
        PER_USER_PER_DAY: String(config.limits.perUserPerDay),
        GLOBAL_PER_DAY: String(config.limits.globalPerDay),
      },
    });
    plans.grant(api, "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem");
    quotas.grant(api, "dynamodb:UpdateItem");
    worker.grantInvoke(api);

    // ── HTTP API ──
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `${config.appName}Api`,
      corsPreflight: {
        allowOrigins: [config.appUrl, ...config.devOrigins],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new HttpJwtAuthorizer("CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${config.auth.userPoolId}`,
      { jwtAudience: [client.userPoolClientId, config.auth.siteClientId] });
    const integration = new HttpLambdaIntegration("PlansIntegration", api);
    httpApi.addRoutes({ path: "/plans", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration, authorizer });
    httpApi.addRoutes({ path: "/plans/{planId}", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.DELETE], integration, authorizer });
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };
    this.apiUrl = httpApi.apiEndpoint;

    if (config.budget.alertEmail) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: `${config.appName}Monthly`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: config.budget.monthlyLimitUsd, unit: "USD" },
          costFilters: { TagKeyValue: [`user:app$${config.appName}`] },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { comparisonOperator: "GREATER_THAN", notificationType: "ACTUAL", threshold, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: config.budget.alertEmail! }],
        })),
      });
    }

    new CfnOutput(this, "ApiUrl", { value: this.apiUrl });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
  }
}
