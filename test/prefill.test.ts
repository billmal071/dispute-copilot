import { describe, expect, it } from "vitest";
import { latestDraft } from "../src/agent/draft.js";
import { DEMO_UNDRAFTED, prefillDemoDrafts } from "../src/seed/prefill.js";
import { makeApp } from "./app-helpers.js";

describe("prefillDemoDrafts", () => {
  it("drafts the seeded disputes from fixtures, leaving a few for the live draft flow", async () => {
    const app = await makeApp();
    const count = await prefillDemoDrafts({ ...app, mode: "mock" });
    expect(count).toBe(13 - DEMO_UNDRAFTED.length);
    expect(latestDraft(app.db, "PP-D-1001")?.source).toBe("replayed");
    for (const id of DEMO_UNDRAFTED) expect(latestDraft(app.db, id)).toBeNull();
  });

  it("is idempotent across restarts", async () => {
    const app = await makeApp();
    await prefillDemoDrafts({ ...app, mode: "mock" });
    expect(await prefillDemoDrafts({ ...app, mode: "mock" })).toBe(0);
    const versions = app.db.prepare("SELECT MAX(version) AS v FROM drafts").get() as { v: number };
    expect(versions.v).toBe(1);
  });

  it("does nothing in sandbox mode or when a live model is configured", async () => {
    const app = await makeApp();
    expect(await prefillDemoDrafts({ ...app, mode: "sandbox" })).toBe(0);
    const live = { ...app.llm, source: "live" as const, label: "x", create: app.llm.create };
    expect(await prefillDemoDrafts({ ...app, mode: "mock", llm: live })).toBe(0);
  });
});
