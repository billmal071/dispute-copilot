# Dispute Copilot: submission text

Draft for the Devpost form. Requirements below come from third-party listings; the official Devpost page and rules returned HTTP 403 to automated fetch, so re-check them in a browser before submitting (see the checklist at the end).

## Title

Dispute Copilot

## Tagline

An AI copilot that investigates a PayPal dispute, drafts the evidence, and sends nothing until a human approves.

## What it does

A small merchant opens the inbox of PayPal disputes, ranked by urgency times expected value. For a chosen dispute, an agent reads the case through the Disputes API, pulls the linked transaction and tracking, checks them against the merchant's seeded policy, and drafts a recommendation (contest, accept, or offer a partial refund) with an evidence list. Each evidence claim cites the tool result it came from. A deterministic 0-100 evidence-quality score (no LLM) shows what is present and what is missing. The merchant reviews the exact outbound request and approves it. Nothing is sent before that.

## How it works

- Server-rendered Hono plus htmx, SQLite, TypeScript strict. Runs on `127.0.0.1` by default.
- The agent is given a read-only PayPal client with five read methods. Write methods exist only on the write client, and only `src/actions/approve.ts` calls it; a test scans the source to enforce this.
- Human approval gate. The approval form carries a CSRF token and is bound to `draft_id` plus `draft_version`, so approving a stale or different draft is refused. Approval takes an atomic in-flight claim on the action row (`pending/failed` to `in_flight` in one UPDATE), so a double click or concurrent retry cannot send twice. The approval key is sent as `PayPal-Request-Id`.
- Submitting without an approval returns 403 and is audited.
- Hash-chained audit log (SHA-256) of tool calls, drafts, decisions, outbound requests and responses, and webhooks. A separate head row stores the entry count and head hash, so truncating or rewriting the tail is detected by `GET /audit/verify`.
- Buyer messages reach the model only as delimited untrusted data. Webhooks are deduplicated by event id.
- Grounding rule: claim-bearing evidence must cite a source that exists in the run's tool results, otherwise the score is penalised and the UI warns.

## How we used PayPal

Customer Disputes API (merchant side), Payments captures, and Shipping trackers, in both a mock client and a sandbox client behind one interface.

Verified against the real PayPal sandbox on 2026-11-10 (from `docs/unverified.md`):

- Token scopes: the client-credentials token carried `read-seller` and `disputes/update-seller`.
- `GET /v1/customer/disputes/{id}` and `GET /v2/payments/captures/{id}` on a real dispute (PP-R-BVH-10197979); the capture had no linked order, so the transaction is assembled without an order call.
- `GET /v1/shipping/trackers?transaction_id=` returned no tracker (treated as "no tracking on file").
- One real write: `POST .../provide-evidence` as JSON with a PROOF_OF_FULFILLMENT tracking entry returned 200 `SUBMITTED`; the dispute moved WAITING_FOR_SELLER_RESPONSE to UNDER_REVIEW and the action links disappeared.
- Evidence type `OTHER` was rejected with 400 `EVIDENCE_TYPE_IS_NOT_ALLOWED` for a not-received inquiry that requested PROOF_OF_FULFILLMENT.
- End-to-end read path (inbox, case view, draft, audit verify) worked on the real dispute.

Not verified (do not claim as working against PayPal):

- Provide-evidence with file uploads (a multipart attempt was rejected with 400; cause unknown).
- accept-claim, make-offer, send-message, sandbox require-evidence and adjudicate writes. They run in mock mode only.
- Webhook signature verification via `/v1/notifications/verify-webhook-signature`.
- Whether PayPal deduplicates on `PayPal-Request-Id` for dispute endpoints (a different id was used after each 400; repeat-id dedup untested).
- Mapping of buyer id, tracker data and refunds on real data beyond the one dispute; mock error codes are plausible, not copied from PayPal.

## Honest disclosures

- No Anthropic API key was available. Every draft in the demo comes from scripted fixtures (`fixtures/llm-cache`, `source: "scripted-fixture"`), written by hand and replayed by a fake LLM following a fixed tool plan. The UI labels them "Scripted demo fixture, not real Claude output". The agent loop is written for `claude-sonnet-5-5` and activates when `ANTHROPIC_API_KEY` is set, but it has never been run against a live model in this submission.
- Because of that, the eval (13 scenarios, 100% recommendation accuracy, mean contest score 91.9) is a cache integrity check, not a measure of model quality.
- The evidence tracking number in the real sandbox write was a labelled placeholder, not a real shipment.
- No claims are made about real merchants, savings, or win rates. There is no baseline comparison.
- No authentication; single merchant user.

## Challenges

- The buyer-side dispute-create API needs scopes that a solo developer cannot get, so test disputes were created by hand in Resolution Center.
- PayPal rejected evidence types the dispute did not request; the app does not yet read the `REQUESTED_FROM_SELLER` list and can still pick a rejected type.
- Making the write path safe against double submits and stale drafts, and keeping the audit log tamper-evident without a server-side secret.
- Keeping an offline demo honest: building a replay path that is clearly labelled rather than passing it off as model output.

## What's next

- Run the agent against a live Claude model and publish real eval numbers with a baseline.
- Read PayPal's requested evidence types and constrain drafts to them.
- Verify and fix file upload, accept-claim, make-offer and webhook signature against the sandbox.
- Carrier lookups for delivery verification; authentication and multi-merchant support.

## Judging-criteria mapping

Criteria as listed by third-party sources: technical implementation, design, potential impact, innovation, presentation. Confirm against the official rules.

| Criterion                | Evidence                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technical implementation | Compile-time read/write split, CSRF plus draft-version-bound approval, atomic in-flight claim, hash-chained anchored audit, 197 tests, real sandbox read and one write |
| Design                   | Four-view flow (inbox, case file, evidence ledger, approval sheet showing the exact outbound request), self-hosted fonts and icons, explicit fixture labels            |
| Potential impact         | Disputes are a real merchant chore; the approval gate keeps the merchant in control. No quantified impact claimed                                                      |
| Innovation               | Grounded-citation rule, deterministic evidence score, prompt-injection handling for buyer messages, tamper-evident audit                                               |
| Presentation             | 2:40 video, README, `docs/unverified.md` listing exactly what is and is not verified                                                                                   |

## Built with

Node 24, TypeScript, Hono, htmx, SQLite (better-sqlite3), Vitest, Biome, Anthropic SDK (`claude-sonnet-5-5`, unused in the demo), PayPal Disputes, Payments and Shipping Trackers APIs.

## Final checklist before submitting (user)

- Open the Devpost rules in a browser and confirm: video length and hosting, repo visibility and licence, required PayPal APIs, judging criteria, deadline time zone.
- Repo is public with the MIT licence visible; no `.env` committed.
- Video is public on YouTube and under the limit.
