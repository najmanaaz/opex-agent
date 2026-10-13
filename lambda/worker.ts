// Generates one stored plan (invoked asynchronously by POST /plans). A plan
// takes ~25 s, longer than API Gateway allows a request to run, so the API
// answers at once and the page polls GET /plans/{planId}.
//
// Writes are conditional on the plan still existing and still PENDING, so a
// plan the user deleted while it was being generated is never brought back.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { generatePlan, PlanError } from "./generate";
import type { SimulationInput } from "./plan";

const PLANS = process.env.PLANS_TABLE!;
const MODEL_ID = process.env.MODEL_ID!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

async function finish(userId: string, planId: string, fields: Record<string, unknown>): Promise<boolean> {
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":pending": "PENDING", ":now": new Date().toISOString() };
  const sets = ["updatedAt = :now"];
  for (const [k, v] of Object.entries(fields)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: PLANS,
      Key: { userId, planId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(planId) AND #s = :pending",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") return false; // deleted meanwhile
    throw e;
  }
}

export async function handler(event: { userId: string; planId: string }): Promise<void> {
  const { userId, planId } = event;
  const t0 = Date.now();
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ outcome, planId, ms: Date.now() - t0, ...extra }));

  const item = (await ddb.send(new GetCommand({ TableName: PLANS, Key: { userId, planId } }))).Item;
  if (!item || item.status !== "PENDING") { log("skipped", { status: item?.status ?? "missing" }); return; }

  try {
    const { plan, usage } = await generatePlan(MODEL_ID, item.input as SimulationInput);
    const kept = await finish(userId, planId, { status: "COMPLETE", plan, usage, model: MODEL_ID });
    log(kept ? "complete" : "deleted_meanwhile", { model: MODEL_ID, ...usage });
  } catch (e) {
    const err = e instanceof PlanError ? e : new PlanError((e as Error).message);
    await finish(userId, planId, {
      status: "FAILED",
      error: err.throttled
        ? "OpEx Agent was busy. Please create the plan again in a minute."
        : "We couldn't generate this plan. Please try again.",
    });
    log("failed", { error: err.message, ...(err.usage ?? {}) });
  }
}
