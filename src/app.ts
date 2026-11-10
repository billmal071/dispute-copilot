import { join } from "node:path";
import { createLLM, type LLM } from "./agent/llm.js";
import type { Clock } from "./clock.js";
import { DEMO_NOW, fixedClock, systemClock } from "./clock.js";
import type { Config } from "./config.js";
import { type Db, openDb } from "./db.js";
import { createMerchantData, type MerchantData } from "./merchant/data.js";
import { type PayPalWriteClient, type ReadOnlyPayPalClient, readOnly } from "./paypal/client.js";
import { MockPayPal, seedMock } from "./paypal/mock.js";
import { SandboxPayPal } from "./paypal/real.js";
import { SCENARIOS } from "./seed/scenarios.js";
import { syncDisputes } from "./sync.js";
import type { SignatureVerifier } from "./webhook.js";

export interface AppContext {
  mode: "mock" | "sandbox";
  db: Db;
  clock: Clock;
  reader: ReadOnlyPayPalClient;
  writer: PayPalWriteClient;
  merchant: MerchantData;
  llm: LLM;
  verify: SignatureVerifier;
}

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
export const LLM_CACHE_DIR = join(FIXTURES, "llm-cache");
export const LLM_CACHE_DIRS = {
  scripted: LLM_CACHE_DIR,
  nvidia: join(FIXTURES, "llm-cache-nvidia"),
  anthropic: join(FIXTURES, "llm-cache-anthropic"),
};

export function createContext(config: Config): AppContext {
  const db = openDb(config.dbPath);
  const llm = createLLM(
    {
      provider: config.llmProvider,
      anthropicApiKey: config.anthropicApiKey,
      nvidiaApiKey: config.nvidiaApiKey,
      nvidiaModel: config.nvidiaModel,
    },
    LLM_CACHE_DIRS,
  );
  const merchant = createMerchantData(db, SCENARIOS);

  if (config.mode === "mock") {
    const clock = fixedClock(config.demoNow ?? DEMO_NOW);
    const seeded = db.prepare("SELECT COUNT(*) AS n FROM mock_disputes").get() as { n: number };
    if (seeded.n === 0) seedMock(db, SCENARIOS);
    const mock = new MockPayPal(db, SCENARIOS, () => clock.now());
    return {
      mode: "mock",
      db,
      clock,
      reader: readOnly(mock),
      writer: mock,
      merchant,
      llm,
      verify: async () => true,
    };
  }

  const sandbox = new SandboxPayPal({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
  });
  const webhookId = config.paypal.webhookId;
  return {
    mode: "sandbox",
    db,
    clock: systemClock(),
    reader: readOnly(sandbox),
    writer: sandbox,
    merchant,
    llm,
    verify: async (headers, event) =>
      webhookId ? sandbox.verifyWebhookSignature(headers, event, webhookId) : false,
  };
}

export async function initialSync(ctx: AppContext): Promise<void> {
  await syncDisputes(ctx);
}
