import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { grantInferenceProfile } from "./bedrock-access";
import type { GoalSimulatorConfig } from "./config";

export interface GoalSimulatorStackProps extends StackProps {
  readonly config: GoalSimulatorConfig;
}

// Why a Lambda Function URL and not API Gateway: a Sonnet plan takes ~25 s
// (measured), and the HTTP API cuts integrations off at 30 s. The Function URL
// allows the full Lambda timeout; the DynamoDB quotas (and, once the account
// limit allows it, reserved concurrency) take the place of API Gateway throttling.
export class GoalSimulatorStack extends Stack {
  constructor(scope: Construct, id: string, props: GoalSimulatorStackProps) {
    super(scope, id, props);
    const { config } = props;
    Tags.of(this).add("app", config.appName);

    const quotas = new dynamodb.Table(this, "Quotas", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY, // only short-lived counters
    });

    // Key for hashing visitor IPs, so the quota table never holds a raw IP
    const hashKey = new secretsmanager.Secret(this, "VisitorHashKey", {
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const fn = new NodejsFunction(this, "Simulate", {
      entry: path.join(__dirname, "..", "lambda", "simulate.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(90),
      reservedConcurrentExecutions: config.limits.maxConcurrent,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, "SimulateLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        MODEL_ID: config.modelId,
        QUOTA_TABLE: quotas.tableName,
        HASH_SECRET_ARN: hashKey.secretArn,
        PER_VISITOR_PER_HOUR: String(config.limits.perVisitorPerHour),
        GLOBAL_PER_DAY: String(config.limits.globalPerDay),
      },
      bundling: { minify: true, sourceMap: true },
    });
    quotas.grant(fn, "dynamodb:UpdateItem");
    hashKey.grantRead(fn);
    grantInferenceProfile(fn, this, config.modelId);

    const url = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: config.allowedOrigins,
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["content-type"],
        maxAge: Duration.hours(1),
      },
    });

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

    new CfnOutput(this, "SimulatorUrl", { value: url.url });
  }
}
