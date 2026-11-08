import { z } from "zod";

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const EnvSchema = z.object({
  MODE: z.preprocess(blankToUndefined, z.enum(["mock", "sandbox"]).default("mock")),
  HOST: z.preprocess(blankToUndefined, z.string().default("127.0.0.1")),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_ENV: z.preprocess(blankToUndefined, z.literal("sandbox").default("sandbox")),
  PAYPAL_WEBHOOK_ID: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  DB_PATH: optionalString,
  DEMO_NOW: optionalString,
});

export interface Config {
  mode: "mock" | "sandbox";
  host: string;
  port: number;
  dbPath: string;
  anthropicApiKey: string | undefined;
  demoNow: string | undefined;
  paypal: {
    env: "sandbox";
    clientId: string;
    clientSecret: string;
    webhookId: string | undefined;
  };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.parse(env);
  if (parsed.MODE === "sandbox") {
    const missing = (["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const).filter(
      (key) => !parsed[key],
    );
    if (missing.length > 0) throw new Error(`MODE=sandbox requires ${missing.join(" and ")}`);
  }
  return {
    mode: parsed.MODE,
    host: parsed.HOST,
    port: parsed.PORT,
    dbPath: parsed.DB_PATH ?? "data/app.db",
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    demoNow: parsed.DEMO_NOW,
    paypal: {
      env: parsed.PAYPAL_ENV,
      clientId: parsed.PAYPAL_CLIENT_ID ?? "",
      clientSecret: parsed.PAYPAL_CLIENT_SECRET ?? "",
      webhookId: parsed.PAYPAL_WEBHOOK_ID,
    },
  };
}
