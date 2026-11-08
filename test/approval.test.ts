import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AlreadyDecidedError,
  ApprovalRequiredError,
  approveDraft,
  buildPayload,
  rejectDraft,
  submitApproved,
  ValidationError,
} from "../src/actions/approve.js";
import { createDraft } from "../src/agent/draft.js";
import { listAudit, verifyChain } from "../src/audit.js";
import { PayPalError } from "../src/paypal/client.js";
import { makeApp } from "./app-helpers.js";

async function drafted(disputeId: string) {
  const app = await makeApp();
  const result = await createDraft(app, disputeId);
  if (result.state !== "ok") throw new Error(result.error);
  return { app, draft: result.draft };
}

const decider = { decidedBy: "merchant@example.com", draftVersion: 1 };
const row = <T>(v: unknown) => v as T;

describe("approval gate", () => {
  it("sends nothing to PayPal until a human approves", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    expect(app.calls).toHaveLength(0);
    expect((await app.mock.getDispute("PP-D-1001")).status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(draft.id).toBeGreaterThan(0);
  });

  it("blocks a submit without an approval, audits the attempt, and never reaches the write client", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    await expect(
      submitApproved({ db: app.db, writer: app.writer, clock: app.clock }, draft.id),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(app.calls).toHaveLength(0);
    const blocked = listAudit(app.db, "PP-D-1001").filter((r) => r.event === "submit_blocked");
    expect(blocked).toHaveLength(1);
  });

  it("approving a contest submits evidence using the idempotency key as PayPal-Request-Id", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const out = await approveDraft(
      { db: app.db, writer: app.writer, clock: app.clock },
      { draftId: draft.id, idempotencyKey: "key-A", ...decider },
    );
    expect(out.status).toBe("ok");
    expect(app.calls).toEqual([{ method: "provideEvidence", requestId: "key-A" }]);
    expect((await app.mock.getDispute("PP-D-1001")).status).toBe("UNDER_REVIEW");
    const local = row<{ status: string }>(
      app.db.prepare("SELECT status FROM disputes WHERE paypal_id = 'PP-D-1001'").get(),
    );
    expect(local.status).toBe("UNDER_REVIEW");
  });

  it("a double click with the same key produces exactly one submission", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const deps = { db: app.db, writer: app.writer, clock: app.clock };
    const a = await approveDraft(deps, { draftId: draft.id, idempotencyKey: "dbl", ...decider });
    const b = await approveDraft(deps, { draftId: draft.id, idempotencyKey: "dbl", ...decider });
    expect(app.calls).toHaveLength(1);
    expect(b.duplicate).toBe(true);
    expect(b.actionId).toBe(a.actionId);
    expect(app.mock.writeCount).toBe(1);
  });

  it("refuses a second decision on an already-decided draft under a new key", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const deps = { db: app.db, writer: app.writer, clock: app.clock };
    await approveDraft(deps, { draftId: draft.id, idempotencyKey: "one", ...decider });
    await expect(
      approveDraft(deps, { draftId: draft.id, idempotencyKey: "two", ...decider }),
    ).rejects.toBeInstanceOf(AlreadyDecidedError);
    expect(app.calls).toHaveLength(1);
  });

  it("reject records the decision and never contacts PayPal", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    await rejectDraft(
      { db: app.db, writer: app.writer, clock: app.clock },
      { draftId: draft.id, idempotencyKey: "rej", ...decider },
    );
    expect(app.calls).toHaveLength(0);
    const approval = row<{ decision: string }>(
      app.db.prepare("SELECT decision FROM approvals").get(),
    );
    expect(approval.decision).toBe("reject");
    await expect(
      submitApproved({ db: app.db, writer: app.writer, clock: app.clock }, draft.id),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("an edited approval sends the edited notes and stores the edit", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const edited = structuredClone(draft.draft);
    const first = edited.evidences[0];
    if (!first) throw new Error("fixture");
    first.notes = `${first.notes} Edited by the merchant.`;
    await approveDraft(
      { db: app.db, writer: app.writer, clock: app.clock },
      { draftId: draft.id, idempotencyKey: "ed", edited, ...decider },
    );
    const approval = row<{ decision: string; edited_json: string }>(
      app.db.prepare("SELECT decision, edited_json FROM approvals").get(),
    );
    expect(approval.decision).toBe("edit");
    expect(approval.edited_json).toContain("Edited by the merchant.");
    const action = row<{ request_json: string }>(
      app.db.prepare("SELECT request_json FROM actions").get(),
    );
    expect(action.request_json).toContain("Edited by the merchant.");
  });

  it("rejects an edit that PayPal would refuse, before recording anything", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const edited = structuredClone(draft.draft);
    const first = edited.evidences[0];
    if (first) first.notes = "x".repeat(2001);
    await expect(
      approveDraft(
        { db: app.db, writer: app.writer, clock: app.clock },
        { draftId: draft.id, idempotencyKey: "bad", edited, ...decider },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  it("maps an ACCEPT draft to accept-claim and an OFFER_PARTIAL draft to make-offer", async () => {
    const lost = await drafted("PP-D-1002");
    await approveDraft(
      { db: lost.app.db, writer: lost.app.writer, clock: lost.app.clock },
      { draftId: lost.draft.id, idempotencyKey: "acc", ...decider },
    );
    expect(lost.app.calls[0]?.method).toBe("acceptClaim");
    expect((await lost.app.mock.getDispute("PP-D-1002")).dispute_outcome?.outcome_code).toBe(
      "RESOLVED_BUYER_FAVOR",
    );

    const partial = await drafted("PP-D-1008");
    await approveDraft(
      { db: partial.app.db, writer: partial.app.writer, clock: partial.app.clock },
      { draftId: partial.draft.id, idempotencyKey: "off", ...decider },
    );
    expect(partial.app.calls[0]?.method).toBe("makeOffer");
    expect((await partial.app.mock.getDispute("PP-D-1008")).status).toBe(
      "WAITING_FOR_BUYER_RESPONSE",
    );
  });

  it("keeps a failed submission retryable under the same key", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    let fail = true;
    const flaky = {
      ...app.writer,
      provideEvidence: async (...args: Parameters<typeof app.writer.provideEvidence>) => {
        if (fail) throw new PayPalError(503, "PAYPAL_UNAVAILABLE", "PayPal unavailable");
        return app.writer.provideEvidence(...args);
      },
    };
    const deps = { db: app.db, writer: flaky, clock: app.clock };
    const first = await approveDraft(deps, {
      draftId: draft.id,
      idempotencyKey: "retry",
      ...decider,
    });
    expect(first.status).toBe("failed");
    expect(first.error).toMatch(/unavailable/i);
    fail = false;
    const second = await approveDraft(deps, {
      draftId: draft.id,
      idempotencyKey: "retry",
      ...decider,
    });
    expect(second.status).toBe("ok");
    const action = row<{ attempts: number; status: string }>(
      app.db.prepare("SELECT attempts, status FROM actions").get(),
    );
    expect(action).toEqual({ attempts: 2, status: "ok" });
    expect(app.mock.writeCount).toBe(1);
  });

  it("records decision, outbound request and response in a verifiable audit chain", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    await approveDraft(
      { db: app.db, writer: app.writer, clock: app.clock },
      { draftId: draft.id, idempotencyKey: "aud", ...decider },
    );
    const events = listAudit(app.db, "PP-D-1001").map((r) => r.event);
    expect(events).toEqual(
      expect.arrayContaining(["human_decision", "outbound_request", "outbound_response"]),
    );
    expect(verifyChain(app.db).ok).toBe(true);
  });

  it("buildPayload previews exactly what would be sent", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const dispute = row<{ raw_json: string }>(
      app.db.prepare("SELECT raw_json FROM disputes WHERE paypal_id = 'PP-D-1001'").get(),
    );
    const payload = buildPayload(JSON.parse(dispute.raw_json), draft.draft);
    expect(payload.kind).toBe("provide-evidence");
    expect(JSON.stringify(payload.request)).toContain("tracking_info");
  });
});

describe("write client is unreachable from the agent", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const src = join(import.meta.dirname, "..", "src");

  it("agent modules never import the approval module or reference write methods", () => {
    for (const file of files(join(src, "agent"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/actions\/approve/);
      expect(text, file).not.toMatch(
        /PayPalWriteClient|(?<!ReadOnly)PayPalClient\b|provideEvidence|acceptClaim|makeOffer|sendMessage/,
      );
    }
  });

  it("only the approval module and the sandbox/mock clients define or call write methods", () => {
    const offenders = files(src).filter((f) =>
      /\.(provideEvidence|acceptClaim|makeOffer|sendMessage)\(/.test(readFileSync(f, "utf8")),
    );
    const names = offenders.map((f) => f.slice(src.length + 1)).sort();
    expect(names).toEqual(["actions/approve.ts"]);
  });
});

describe("concurrent submission", () => {
  function slowWriter(app: Awaited<ReturnType<typeof drafted>>["app"], fail = false) {
    let outbound = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = {
      ...app.writer,
      provideEvidence: async (...args: Parameters<typeof app.writer.provideEvidence>) => {
        outbound++;
        await gate;
        if (fail) throw new PayPalError(503, "PAYPAL_UNAVAILABLE", "PayPal unavailable");
        return app.writer.provideEvidence(...args);
      },
    };
    return { writer, release, outbound: () => outbound };
  }

  it("sends once when approve x2 and submit arrive while the write is in flight", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const slow = slowWriter(app);
    const deps = { db: app.db, writer: slow.writer, clock: app.clock };
    const input = { draftId: draft.id, idempotencyKey: "race", ...decider };
    const first = approveDraft(deps, input);
    const second = approveDraft(deps, input);
    const third = submitApproved(deps, draft.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slow.outbound()).toBe(1);
    slow.release();
    const outcomes = await Promise.all([first, second, third]);
    expect(slow.outbound()).toBe(1);
    expect(app.mock.writeCount).toBe(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["in_flight", "in_flight", "ok"]);
    const action = row<{ status: string; attempts: number }>(
      app.db.prepare("SELECT status, attempts FROM actions").get(),
    );
    expect(action).toEqual({ status: "ok", attempts: 1 });
  });

  it("a late failure cannot overwrite a recorded success", async () => {
    const { app, draft } = await drafted("PP-D-1001");
    const slow = slowWriter(app, true);
    const deps = { db: app.db, writer: slow.writer, clock: app.clock };
    const pending = approveDraft(deps, { draftId: draft.id, idempotencyKey: "late", ...decider });
    app.db
      .prepare("UPDATE actions SET status = 'ok', response_json = '{\"status\":\"UNDER_REVIEW\"}'")
      .run();
    slow.release();
    await pending;
    const action = row<{ status: string; response_json: string }>(
      app.db.prepare("SELECT status, response_json FROM actions").get(),
    );
    expect(action.status).toBe("ok");
    expect(action.response_json).not.toContain("PAYPAL_UNAVAILABLE");
  });
});
