import { join } from "node:path";
import { ReplayLLM, ResponseCache } from "../src/agent/llm.js";
import { DEMO_NOW, fixedClock } from "../src/clock.js";
import { openDb } from "../src/db.js";
import { createMerchantData } from "../src/merchant/data.js";
import { type PayPalWriteClient, readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS } from "../src/seed/scenarios.js";
import { syncDisputes } from "../src/sync.js";

export const cacheDir = join(import.meta.dirname, "..", "fixtures", "llm-cache");

export async function makeApp() {
  const db = openDb(":memory:");
  seedMock(db, SCENARIOS);
  const mock = new MockPayPal(db, SCENARIOS, () => new Date(DEMO_NOW));
  const clock = fixedClock(DEMO_NOW);
  const reader = readOnly(mock);
  const merchant = createMerchantData(db, SCENARIOS);
  const llm = new ReplayLLM(new ResponseCache(cacheDir));
  await syncDisputes({ db, reader, clock });
  const calls: { method: string; requestId: string }[] = [];
  const record = (method: string, requestId: string) => {
    calls.push({ method, requestId });
  };
  const writer: PayPalWriteClient = {
    provideEvidence: (id, req, rid) => {
      record("provideEvidence", rid);
      return mock.provideEvidence(id, req, rid);
    },
    acceptClaim: (id, req, rid) => {
      record("acceptClaim", rid);
      return mock.acceptClaim(id, req, rid);
    },
    makeOffer: (id, req, rid) => {
      record("makeOffer", rid);
      return mock.makeOffer(id, req, rid);
    },
    sendMessage: (id, m, rid) => {
      record("sendMessage", rid);
      return mock.sendMessage(id, m, rid);
    },
  };
  return { db, mock, clock, reader, merchant, llm, writer, calls };
}
