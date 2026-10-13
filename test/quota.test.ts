import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { dayBucket, hourBucket, takeQuota, visitorKey } from "../lambda/quota";

// In-memory stand-in for DynamoDB that honours the conditional update
function fakeDdb() {
  const counts = new Map<string, number>();
  return {
    counts,
    async send(cmd: { input: { Key: { pk: { S: string } }; ExpressionAttributeValues: Record<string, { N: string }> } }) {
      const pk = cmd.input.Key.pk.S;
      const limit = Number(cmd.input.ExpressionAttributeValues[":limit"].N);
      const n = counts.get(pk) ?? 0;
      if (n >= limit) throw new ConditionalCheckFailedException({ message: "limit", $metadata: {} });
      counts.set(pk, n + 1);
      return {};
    },
  };
}

test("allows up to the limit, then refuses without counting", async () => {
  const ddb = fakeDdb();
  const now = new Date("2026-10-13T19:05:00Z");
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await takeQuota(ddb as never, "t", "visitor#a#h", 3, now, 7200));
  assert.deepEqual(results, [true, true, true, false]);
  assert.equal(ddb.counts.get("visitor#a#h"), 3);
});

test("other errors are not mistaken for an exhausted quota", async () => {
  const ddb = { send: async () => { throw Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" }); } };
  await assert.rejects(takeQuota(ddb as never, "t", "k", 3, new Date(), 60), /boom/);
});

test("visitor keys are stable, secret-dependent and never the raw IP", () => {
  const a = visitorKey("203.0.113.7", "s1");
  assert.equal(a, visitorKey("203.0.113.7", "s1"));
  assert.notEqual(a, visitorKey("203.0.113.7", "s2"));
  assert.notEqual(a, visitorKey("203.0.113.8", "s1"));
  assert.ok(!a.includes("203"));
});

test("buckets roll over by the hour and the day", () => {
  assert.equal(hourBucket(new Date("2026-10-13T19:59:59Z")), "2026-10-13T19");
  assert.equal(hourBucket(new Date("2026-10-13T20:00:00Z")), "2026-10-13T20");
  assert.equal(dayBucket(new Date("2026-10-13T23:59:59Z")), "2026-10-13");
});
