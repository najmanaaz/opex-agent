// Usage quotas in DynamoDB: per user per day, and for everyone per day.
// Each quota is one item with an atomic counter that expires on its own (TTL).

import { ConditionalCheckFailedException, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

export function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10); // 2026-10-13
}

/**
 * Count one use against `pk`. Returns false (and counts nothing) when the
 * quota is already used up. The item expires `ttlSeconds` after `now`.
 */
export async function takeQuota(
  ddb: Pick<DynamoDBClient, "send">,
  table: string,
  pk: string,
  limit: number,
  now: Date,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: { pk: { S: pk } },
      UpdateExpression: "ADD #n :one SET expiresAt = if_not_exists(expiresAt, :exp)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: {
        ":one": { N: "1" },
        ":limit": { N: String(limit) },
        ":exp": { N: String(Math.floor(now.getTime() / 1000) + ttlSeconds) },
      },
    }));
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}
