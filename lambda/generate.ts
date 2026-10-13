// One plan from Claude on Bedrock: the Converse API with a forced call to the
// submit_plan tool, whose input schema is the plan. Shared by the worker and the
// legacy public endpoint.

import { BedrockRuntimeClient, ConverseCommand, type ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import { buildPrompt, checkPlan, PLAN_SCHEMA, SYSTEM_PROMPT, type SimulationInput } from "./plan";

const bedrock = new BedrockRuntimeClient({});

export interface GeneratedPlan {
  plan: Record<string, unknown>;
  usage: { inputTokens?: number; outputTokens?: number };
}

export class PlanError extends Error {
  constructor(message: string, readonly throttled = false, readonly usage?: GeneratedPlan["usage"]) {
    super(message);
  }
}

export async function generatePlan(modelId: string, input: SimulationInput): Promise<GeneratedPlan> {
  let res;
  try {
    res = await bedrock.send(new ConverseCommand({
      modelId,
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
  } catch (e) {
    throw new PlanError((e as Error).name || "model error", (e as Error).name === "ThrottlingException");
  }
  const usage = { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
  const plan = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse?.input;
  const problem = res.stopReason === "max_tokens" ? "plan cut off at max tokens" : checkPlan(plan);
  if (problem) throw new PlanError(problem, false, usage);
  return { plan: plan as Record<string, unknown>, usage };
}
