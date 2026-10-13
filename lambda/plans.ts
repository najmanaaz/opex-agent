// OpEx Agent API (HTTP API, Cognito JWT authorizer). Every route acts
// only on the caller's own plans: the user id is the token's `sub`, never a
// request field.
//
//   POST   /plans            validate, check quotas, store PENDING, start the worker -> 202 { planId }
//   GET    /plans            the caller's plans, newest first (summary fields only)
//   GET    /plans/{planId}   one plan, with its inputs and (once COMPLETE) the plan
//   DELETE /plans/{planId}   delete it; a plan still being generated is not brought back

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { parseRequest } from "./plan";
import { dayBucket, takeQuota } from "./quota";

const PLANS = process.env.PLANS_TABLE!;
const QUOTAS = process.env.QUOTA_TABLE!;
const WORKER = process.env.WORKER_FUNCTION!;
const PER_USER_PER_DAY = Number(process.env.PER_USER_PER_DAY || 20);
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_PER_DAY || 300);
const LIST_LIMIT = 50;

const raw = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient({});

const json = (statusCode: number, body?: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: body === undefined ? "" : JSON.stringify(body),
});

/** Sortable, unique plan id: 20261013231805-<uuid> */
export function newPlanId(now: Date): string {
  return now.toISOString().replace(/\D/g, "").slice(0, 14) + "-" + randomUUID();
}

const validPlanId = (id: unknown): id is string => typeof id === "string" && /^\d{14}-[0-9a-f-]{36}$/.test(id);

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const userId = String(event.requestContext.authorizer?.jwt?.claims?.sub ?? "");
  if (!userId) return json(401, { error: "Please sign in." });
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ route: event.routeKey, outcome, requestId: event.requestContext.requestId, ...extra }));

  switch (event.routeKey) {
    case "POST /plans": {
      let body: unknown;
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "{}");
      } catch {
        return json(400, { error: "Invalid request." });
      }
      const input = parseRequest(body);
      if ("error" in input) { log("invalid"); return json(400, { error: input.error }); }

      const now = new Date();
      if (!(await takeQuota(raw, QUOTAS, `user#${userId}#${dayBucket(now)}`, PER_USER_PER_DAY, now, 2 * 86400))) {
        log("user_quota");
        return json(429, { error: `You can create up to ${PER_USER_PER_DAY} plans a day. Please try again tomorrow.` });
      }
      if (!(await takeQuota(raw, QUOTAS, `global#${dayBucket(now)}`, GLOBAL_PER_DAY, now, 2 * 86400))) {
        log("global_quota");
        return json(429, { error: "OpEx Agent has reached today's limit. Please try again tomorrow." });
      }

      const planId = newPlanId(now);
      const at = now.toISOString();
      await ddb.send(new PutCommand({
        TableName: PLANS,
        Item: { userId, planId, status: "PENDING", input, createdAt: at, updatedAt: at },
      }));
      await lambda.send(new InvokeCommand({
        FunctionName: WORKER,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ userId, planId })),
      }));
      log("accepted", { planId });
      return json(202, { planId, status: "PENDING" });
    }

    case "GET /plans": {
      const res = await ddb.send(new QueryCommand({
        TableName: PLANS,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ProjectionExpression: "planId, #s, createdAt, updatedAt, #i.goal",
        ExpressionAttributeNames: { "#s": "status", "#i": "input" },
        ScanIndexForward: false,
        Limit: LIST_LIMIT,
      }));
      const plans = (res.Items ?? []).map((p) => ({
        planId: p.planId, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt, goal: p.input?.goal ?? "",
      }));
      return json(200, { plans });
    }

    case "GET /plans/{planId}": {
      const planId = event.pathParameters?.planId;
      if (!validPlanId(planId)) return json(404, { error: "Plan not found." });
      const res = await ddb.send(new GetCommand({ TableName: PLANS, Key: { userId, planId } }));
      if (!res.Item) return json(404, { error: "Plan not found." });
      const { userId: _owner, usage: _usage, ...plan } = res.Item;
      return json(200, plan);
    }

    case "DELETE /plans/{planId}": {
      const planId = event.pathParameters?.planId;
      if (!validPlanId(planId)) return json(404, { error: "Plan not found." });
      try {
        await ddb.send(new DeleteCommand({
          TableName: PLANS, Key: { userId, planId }, ConditionExpression: "attribute_exists(planId)",
        }));
      } catch (e) {
        if ((e as Error).name === "ConditionalCheckFailedException") return json(404, { error: "Plan not found." });
        throw e;
      }
      log("deleted", { planId });
      return json(204);
    }

    default:
      return json(404, { error: "Not found." });
  }
}
