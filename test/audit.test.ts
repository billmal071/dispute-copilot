import { beforeEach, describe, expect, it } from "vitest";
import { appendAudit, listAudit, verifyChain } from "../src/audit.js";
import { type Db, openDb } from "../src/db.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 12, n)).toISOString();

describe("audit chain", () => {
  it("links each row to the previous hash, starting from a zero hash", () => {
    const a = appendAudit(db, {
      actor: "agent",
      event: "tool_call",
      disputeId: "D1",
      payload: { n: 1 },
      ts: at(0),
    });
    const b = appendAudit(db, {
      actor: "human",
      event: "approved",
      disputeId: "D1",
      payload: { n: 2 },
      ts: at(1),
    });
    expect(a.prev_hash).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies an intact chain", () => {
    for (let i = 0; i < 5; i++) {
      appendAudit(db, { actor: "system", event: "e", disputeId: null, payload: { i }, ts: at(i) });
    }
    expect(verifyChain(db)).toEqual({ ok: true, length: 5 });
  });

  it("detects a tampered payload and reports the row", () => {
    for (let i = 0; i < 3; i++) {
      appendAudit(db, { actor: "system", event: "e", disputeId: null, payload: { i }, ts: at(i) });
    }
    db.prepare("UPDATE audit SET payload_json = ? WHERE id = 2").run('{"i":99}');
    expect(verifyChain(db)).toEqual({ ok: false, length: 3, brokenAt: 2 });
  });

  it("detects a deleted row", () => {
    for (let i = 0; i < 3; i++) {
      appendAudit(db, { actor: "system", event: "e", disputeId: null, payload: { i }, ts: at(i) });
    }
    db.prepare("DELETE FROM audit WHERE id = 2").run();
    const result = verifyChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it("detects truncation of the last rows by checking the anchored head", () => {
    for (let i = 0; i < 5; i++) {
      appendAudit(db, { actor: "system", event: "e", disputeId: null, payload: { i }, ts: at(i) });
    }
    db.prepare("DELETE FROM audit WHERE id > 3").run();
    expect(verifyChain(db)).toEqual({ ok: false, length: 3, brokenAt: 4 });
  });

  it("detects removal of every row", () => {
    appendAudit(db, { actor: "system", event: "e", disputeId: null, payload: {}, ts: at(0) });
    db.prepare("DELETE FROM audit").run();
    expect(verifyChain(db).ok).toBe(false);
  });

  it("hashes payloads independent of key order", () => {
    const a = appendAudit(db, {
      actor: "system",
      event: "e",
      disputeId: null,
      payload: { a: 1, b: 2 },
      ts: at(0),
    });
    const other = openDb(":memory:");
    const b = appendAudit(other, {
      actor: "system",
      event: "e",
      disputeId: null,
      payload: { b: 2, a: 1 },
      ts: at(0),
    });
    expect(a.hash).toBe(b.hash);
  });

  it("filters by dispute", () => {
    appendAudit(db, { actor: "agent", event: "x", disputeId: "D1", payload: {}, ts: at(0) });
    appendAudit(db, { actor: "agent", event: "y", disputeId: "D2", payload: {}, ts: at(1) });
    expect(listAudit(db, "D2").map((r) => r.event)).toEqual(["y"]);
  });
});
