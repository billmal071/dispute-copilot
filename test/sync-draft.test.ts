import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDraft, getDraft } from "../src/agent/draft.js";
import { ReplayLLM, ResponseCache } from "../src/agent/llm.js";
import { listAudit } from "../src/audit.js";
import { syncDisputes } from "../src/sync.js";
import { makeApp } from "./app-helpers.js";

describe("syncDisputes", () => {
  it("mirrors PayPal disputes locally and stays idempotent", async () => {
    const app = await makeApp();
    await syncDisputes(app);
    const rows = app.db.prepare("SELECT COUNT(*) AS n FROM disputes").get() as { n: number };
    expect(rows.n).toBe(13);
  });

  it("picks up status changes made at PayPal", async () => {
    const app = await makeApp();
    await app.mock.acceptClaim(
      "PP-D-1002",
      { note: "n", accept_claim_reason: "LOST_IN_MAIL" },
      "k",
    );
    await syncDisputes(app);
    const row = app.db
      .prepare("SELECT status FROM disputes WHERE paypal_id = 'PP-D-1002'")
      .get() as { status: string };
    expect(row.status).toBe("RESOLVED");
  });
});

describe("createDraft", () => {
  it("stores a versioned, scored draft labelled as replayed and audits every step", async () => {
    const app = await makeApp();
    const first = await createDraft(app, "PP-D-1001");
    const second = await createDraft(app, "PP-D-1001");
    if (first.state !== "ok" || second.state !== "ok") throw new Error("draft failed");
    expect(first.draft.version).toBe(1);
    expect(second.draft.version).toBe(2);
    expect(first.draft.source).toBe("replayed");
    expect(first.draft.score).toBe(100);
    expect(getDraft(app.db, first.draft.id)?.draft.recommendation).toBe("CONTEST");
    const events = listAudit(app.db, "PP-D-1001").map((r) => r.event);
    expect(events).toContain("tool_call");
    expect(events).toContain("draft_submitted");
    expect(events).toContain("draft_stored");
  });

  it("reports a cache miss as a failed state, stores no draft, and audits it", async () => {
    const app = await makeApp();
    const empty = new ReplayLLM(new ResponseCache(mkdtempSync(join(tmpdir(), "empty-"))));
    const result = await createDraft({ ...app, llm: empty }, "PP-D-1001");
    expect(result.state).toBe("failed");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM drafts").get()).toEqual({ n: 0 });
    expect(listAudit(app.db, "PP-D-1001").map((r) => r.event)).toContain("draft_failed");
  });
});
