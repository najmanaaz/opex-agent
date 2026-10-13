// Everything you would change between deployments lives here.

export interface GoalSimulatorConfig {
  readonly appName: string;
  /** One EU region; the model is called through an EU cross-region inference profile. */
  readonly region: string;
  /** Bedrock inference profile id. Switch to eu.anthropic.claude-sonnet-5-5 once the account can use it. */
  readonly modelId: string;
  /** Sites allowed to call the simulator from a browser. */
  readonly allowedOrigins: string[];
  readonly limits: {
    readonly perVisitorPerHour: number;
    readonly globalPerDay: number;
    /**
     * Simulations allowed to run at the same time (Lambda reserved concurrency).
     * Needs an account concurrency limit above 10: AWS keeps at least 10 unreserved,
     * and new accounts start with exactly 10. Leave undefined until the limit is raised.
     */
    readonly maxConcurrent?: number;
  };
  readonly budget: { readonly monthlyLimitUsd: number; readonly alertEmail?: string };
}

export function loadConfig(context: { alertEmail?: string }): GoalSimulatorConfig {
  return {
    appName: "GoalSimulator",
    region: "eu-central-1",
    modelId: "eu.anthropic.claude-sonnet-4-6",
    allowedOrigins: ["https://www.t4tangerine.com", "https://t4tangerine.com", "http://localhost:3000"],
    limits: { perVisitorPerHour: 10, globalPerDay: 200, maxConcurrent: undefined },
    budget: { monthlyLimitUsd: 50, alertEmail: context.alertEmail },
  };
}
