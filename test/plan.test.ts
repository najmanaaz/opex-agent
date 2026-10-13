import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, checkPlan, LIMITS, parseRequest, PLAN_SCHEMA } from "../lambda/plan";

const ok = { goal: "Cut Tier 1 first-response time from 4.2 to 2 hours", teamSize: 6, timeline: 12, domain: "Engineering,Operations",
  availableRoles: [{ role: "Backend Engineer", count: 3 }, { role: "Support Lead", count: "1" }] };

test("accepts a normal request and normalises it", () => {
  const r = parseRequest(ok);
  assert.ok(!("error" in r));
  assert.equal(r.teamSize, 6);
  assert.deepEqual(r.domains, ["Engineering", "Operations"]);
  assert.deepEqual(r.roles, [{ role: "Backend Engineer", count: 3 }, { role: "Support Lead", count: 1 }]);
});

test("rejects goals that are too short or too long", () => {
  assert.ok("error" in parseRequest({ ...ok, goal: "short" }));
  assert.ok("error" in parseRequest({ ...ok, goal: "x".repeat(LIMITS.goalMaxChars + 1) }));
  assert.ok("error" in parseRequest(null));
});

test("clamps numbers and drops unknown domains and junk roles", () => {
  const r = parseRequest({ ...ok, teamSize: 10_000, timeline: -3, domain: "Marketing", availableRoles: [{ role: 42 }, { role: "  " }, { role: "QA", count: 999 }] });
  assert.ok(!("error" in r));
  assert.equal(r.teamSize, LIMITS.teamSize.max);
  assert.equal(r.timelineWeeks, LIMITS.timelineWeeks.min);
  assert.deepEqual(r.domains, ["Engineering"]);
  assert.deepEqual(r.roles, [{ role: "QA", count: LIMITS.roleCount.max }]);
});

test("caps the number and length of roles", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ role: "R".repeat(200) + i, count: 1 }));
  const r = parseRequest({ ...ok, availableRoles: many });
  assert.ok(!("error" in r));
  assert.equal(r.roles.length, LIMITS.maxRoles);
  assert.ok(r.roles.every((x) => x.role.length <= LIMITS.roleNameMaxChars));
});

test("the prompt fences the user's goal and states the constraints", () => {
  const r = parseRequest(ok);
  assert.ok(!("error" in r));
  const p = buildPrompt(r);
  assert.match(p, /<goal>\nCut Tier 1/);
  assert.match(p, /Timeline constraint: 12 weeks/);
  assert.match(p, /team size of 6/);
});

test("checkPlan accepts a complete plan and names what is missing", () => {
  const plan = Object.fromEntries(PLAN_SCHEMA.required.map((k) => [k, ["subGoals", "roles", "skills", "costFactors", "risks", "hiringNeeded"].includes(k) ? [{}] : "x"]));
  assert.equal(checkPlan(plan), null);
  assert.equal(checkPlan({ ...plan, risks: undefined }), "risks is not a list");
  const { summary: _, ...noSummary } = plan;
  assert.equal(checkPlan(noSummary), "missing summary");
  assert.equal(checkPlan({ ...plan, subGoals: [] }), "no sub-goals");
});
