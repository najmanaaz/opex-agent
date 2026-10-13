// LEGACY anonymous endpoint (POST / on a Lambda Function URL) used by the blog
// article's embedded demo; replaced by the signed-in OpEx Intelligence API.
// Flow: validate -> quotas (per visitor, global) -> Claude on Bedrock with a
// forced tool call whose schema is the plan -> check the plan -> JSON.
// CORS is configured on the Function URL, not here.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { generatePlan, type PlanError } from "./generate";
import { parseRequest } from "./plan";
import { dayBucket, hourBucket, takeQuota, visitorKey } from "./quota";

const MODEL_ID = process.env.MODEL_ID!;
const TABLE = process.env.QUOTA_TABLE!;
const PER_VISITOR_PER_HOUR = Number(process.env.PER_VISITOR_PER_HOUR || 10);
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_PER_DAY || 200);

const ddb = new DynamoDBClient({});
const secrets = new SecretsManagerClient({});
let hashKey: string | undefined;

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

async function getHashKey(): Promise<string> {
  hashKey ??= (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.HASH_SECRET_ARN! }))).SecretString!;
  return hashKey;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const t0 = Date.now();
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ outcome, ms: Date.now() - t0, requestId: event.requestContext?.requestId, ...extra }));

  if (event.requestContext?.http?.method !== "POST") return json(405, { error: "Method not allowed" });

  let body: unknown;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request." });
  }
  const input = parseRequest(body);
  if ("error" in input) { log("invalid"); return json(400, { error: input.error }); }

  const now = new Date();
  const visitor = visitorKey(event.requestContext.http.sourceIp, await getHashKey());
  if (!(await takeQuota(ddb, TABLE, `visitor#${visitor}#${hourBucket(now)}`, PER_VISITOR_PER_HOUR, now, 2 * 3600))) {
    log("visitor_quota");
    return json(429, { error: "You've run the simulator several times in the last hour. Please try again later." });
  }
  if (!(await takeQuota(ddb, TABLE, `global#${dayBucket(now)}`, GLOBAL_PER_DAY, now, 2 * 86400))) {
    log("global_quota");
    return json(429, { error: "The simulator has reached today's limit. Please try again tomorrow." });
  }

  try {
    const { plan, usage } = await generatePlan(MODEL_ID, input);
    log("ok", { model: MODEL_ID, ...usage, subGoals: (plan.subGoals as unknown[]).length });
    return json(200, plan);
  } catch (e) {
    const err = e as PlanError;
    log(err.usage ? "bad_plan" : "model_error", { error: err.message, ...(err.usage ?? {}) });
    return json(err.throttled ? 429 : 502, {
      error: err.throttled
        ? "The simulator is busy right now. Please try again in a minute."
        : "We couldn't generate your goal decomposition right now. Please try again in a moment.",
    });
  }
}
