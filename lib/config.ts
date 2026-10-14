// Everything you would change between deployments lives here.

export interface OpexConfig {
  readonly appName: string;
  /** One EU region; the model is called through an EU cross-region inference profile. */
  readonly region: string;
  /** Bedrock inference profile id. Switch to eu.anthropic.claude-sonnet-5-5 once the account can use it. */
  readonly modelId: string;
  /** The signed-in app (CloudFront custom domain). */
  readonly appDomain: string;
  readonly appUrl: string;
  /** Local origins allowed to sign in and call the API while developing. */
  readonly devOrigins: string[];
  /** Links in the app back to the main website. */
  readonly publicSiteUrl: string;
  /**
   * Existing Cognito user pool shared with the Stack Optimizer, so one
   * T4Tangerine account signs in to both apps. This app adds its own client.
   */
  readonly auth: { readonly userPoolId: string; readonly loginUrl: string };
  readonly limits: {
    readonly perUserPerDay: number;
    readonly globalPerDay: number;
  };
  readonly budget: { readonly monthlyLimitUsd: number; readonly alertEmail?: string };
}

export function loadConfig(context: { alertEmail?: string }): OpexConfig {
  const appDomain = "opex.t4tangerine.com";
  return {
    appName: "OpexIntelligence",
    region: "eu-central-1",
    modelId: "eu.anthropic.claude-sonnet-4-6",
    appDomain,
    appUrl: `https://${appDomain}`,
    devOrigins: ["http://localhost:3000"],
    publicSiteUrl: "https://www.t4tangerine.com",
    auth: {
      userPoolId: "eu-central-1_CJOLuerYY",
      loginUrl: "https://t4tangerine-stack-optimizer.auth.eu-central-1.amazoncognito.com",
    },
    limits: { perUserPerDay: 20, globalPerDay: 300 },
    budget: { monthlyLimitUsd: 50, alertEmail: context.alertEmail },
  };
}
