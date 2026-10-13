#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { GoalSimulatorStack } from "../lib/goal-simulator-stack";

const app = new App();
const config = loadConfig({ alertEmail: app.node.tryGetContext("alertEmail") });

new GoalSimulatorStack(app, "GoalSimulator", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: "Goal decomposition simulator: Lambda Function URL + Claude on Amazon Bedrock",
  config,
});
