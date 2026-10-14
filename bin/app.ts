#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack";
import { CertStack } from "../lib/cert-stack";
import { loadConfig } from "../lib/config";
import { GoalSimulatorStack } from "../lib/goal-simulator-stack";
import { WebStack } from "../lib/web-stack";

const app = new App();
const config = loadConfig({ alertEmail: app.node.tryGetContext("alertEmail") });
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Capacity Planning: signed-in app at opex.t4tangerine.com
const cert = new CertStack(app, "OpexIntelligence-Cert", {
  env: { account, region: "us-east-1" },
  crossRegionReferences: true,
  description: "Capacity Planning: HTTPS certificate for CloudFront",
  config,
});
const api = new ApiStack(app, "OpexIntelligence-Api", {
  env: { account, region: config.region },
  description: "Capacity Planning: Cognito-protected plans API, async worker, Claude on Amazon Bedrock",
  config,
});
new WebStack(app, "OpexIntelligence-Web", {
  env: { account, region: config.region },
  crossRegionReferences: true,
  description: "Capacity Planning: S3 + CloudFront app",
  config,
  certificate: cert.certificate,
  apiUrl: api.apiUrl,
  userPoolClientId: api.userPoolClientId,
});

// LEGACY anonymous endpoint behind the blog article's embedded demo
new GoalSimulatorStack(app, "GoalSimulator", {
  env: { account, region: config.region },
  description: "Goal decomposition simulator: Lambda Function URL + Claude on Amazon Bedrock",
  config,
});
