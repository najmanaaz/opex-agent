// POST / (Lambda Function URL): turn a goal into a resource plan.
// Flow: validate -> quotas (per visitor, global) -> Claude on Bedrock with a
// forced tool call whose schema is the plan -> check the plan -> JSON.
// CORS is configured on the Function URL, not here.

import { BedrockRuntimeClient, ConverseCommand, type ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { buildPrompt, checkPlan, parseRequest, PLAN_SCHEMA, SYSTEM_PROMPT } from "./plan";
import { dayBucket, hourBucket, takeQuota, visitorKey } from "./quota";

const MODEL_ID = process.env.MODEL_ID!;
const TABLE = process.env.QUOTA_TABLE!;
const PER_VISITOR_PER_HOUR = Number(process.env.PER_VISITOR_PER_HOUR || 10);
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_PER_DAY || 200);

const bedrock = new BedrockRuntimeClient({});
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
    const res = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: [{ text: buildPrompt(input) }] }],
      inferenceConfig: { maxTokens: 6000 },
      toolConfig: {
        tools: [{ toolSpec: {
          name: "submit_plan",
          description: "Submit the finished resource plan for the goal.",
          inputSchema: { json: PLAN_SCHEMA } as unknown as ToolInputSchema,
        } }],
        toolChoice: { tool: { name: "submit_plan" } },
      },
    }));
    const usage = { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
    const plan = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse?.input;
    const problem = res.stopReason === "max_tokens" ? "plan cut off at max tokens" : checkPlan(plan);
    if (problem) {
      log("bad_plan", { problem, stopReason: res.stopReason, ...usage });
      return json(502, { error: "We couldn't generate your goal decomposition right now. Please try again in a moment." });
    }
    log("ok", { model: MODEL_ID, ...usage, subGoals: (plan as { subGoals: unknown[] }).subGoals.length });
    return json(200, plan);
  } catch (e) {
    log("model_error", { error: (e as Error).name });
    const throttled = (e as Error).name === "ThrottlingException";
    return json(throttled ? 429 : 502, {
      error: throttled
        ? "The simulator is busy right now. Please try again in a minute."
        : "We couldn't generate your goal decomposition right now. Please try again in a moment.",
    });
  }
}
