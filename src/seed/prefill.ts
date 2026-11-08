import { createDraft, latestDraft } from "../agent/draft.js";
import type { AppContext } from "../app.js";

export const DEMO_UNDRAFTED = ["PP-D-1012", "PP-D-1013"];

type PrefillContext = Pick<AppContext, "mode" | "db" | "reader" | "merchant" | "llm" | "clock">;

export async function prefillDemoDrafts(ctx: PrefillContext): Promise<number> {
  if (ctx.mode !== "mock" || ctx.llm.source !== "replayed") return 0;
  const ids = (
    ctx.db.prepare("SELECT paypal_id FROM disputes ORDER BY paypal_id").all() as {
      paypal_id: string;
    }[]
  ).map((r) => r.paypal_id);
  let drafted = 0;
  for (const id of ids) {
    if (DEMO_UNDRAFTED.includes(id) || latestDraft(ctx.db, id)) continue;
    const outcome = await createDraft(ctx, id);
    if (outcome.state === "ok") drafted++;
  }
  return drafted;
}
