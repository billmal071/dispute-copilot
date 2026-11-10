# Dispute Copilot

An AI copilot for small merchants that investigates a PayPal dispute, drafts the evidence response, scores it, and sends nothing until a human approves.

Status: slice 1 (skeleton, mock and sandbox clients, agent, approval gate, audit chain, UI). Screenshots, the baseline comparison and the demo video come later.

## Quick start (no credentials)

```sh
git clone <repo> dispute-copilot && cd dispute-copilot
npm install
cp .env.example .env
npm run seed
npm start
# open http://localhost:3000
```

Requires Node 24. With `MODE=mock` (default) everything runs offline on 13 seeded disputes. Without `ANTHROPIC_API_KEY` the agent uses a scripted demo fixture from `fixtures/llm-cache`, not real Claude output; the UI labels these drafts "Scripted demo fixture". Mock mode uses a fixed demo clock (`DEMO_NOW`) so replayed inputs stay identical.

## Interface

Server-rendered Hono plus htmx, fonts (Instrument Serif, Geist, Geist Mono; SIL OFL) and icons self-hosted, no CDN. The inbox ranks disputes by urgency times expected value (amount times evidence score for contests; an estimate, not a PayPal prediction). The dispute page shows the case file, a win-chance gauge with its score breakdown, an evidence ledger flagging what is missing and what to collect, and an approval sheet with the exact outbound request. In mock mode with no model key, startup pre-drafts most seeded disputes from the scripted fixtures so the demo opens populated; two are left undrafted to show the draft flow. `npx tsx scripts/build-icons.ts` regenerates the favicon set.

## Demo fixtures vs live model

The files in `fixtures/llm-cache` are scripted demo fixtures written by `scripts/build-llm-cache.ts`. A fake LLM that follows a fixed tool plan and returns hand-written drafts produced them (`source: "scripted-fixture"`), and no Claude model was called. They exist so the app, the approval flow and the score run offline with no credentials. Their drafts and the replay eval numbers say nothing about model quality. With `ANTHROPIC_API_KEY` set, the same agent loop calls `claude-sonnet-5-5`, the UI shows the live model name, and responses are recorded into the cache as `source: "anthropic"`.

## Commands

| Command                              | What it does                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `npm start` / `npm run dev`          | Run the server (dev watches)                                                                  |
| `npm run build`                      | Compile to `dist/`                                                                            |
| `npm test`                           | Unit and route tests (no network)                                                             |
| `npm run typecheck` / `npm run lint` | tsc strict / Biome                                                                            |
| `npm run seed`                       | Reset the local DB and mock disputes                                                          |
| `npm run eval`                       | Run the agent over all 13 scenarios, write `eval/results.md`                                  |
| `npm run cache:build`                | Regenerate scripted fixture recordings (needed after changing the prompt, tools or seed data) |

## Modes

- `MODE=mock`: `MockPayPal` with seeded disputes, transactions, tracking and Disputes-API-like write endpoints (status rules, validation, `PayPal-Request-Id` idempotency).
- `MODE=sandbox`: `SandboxPayPal` against `api-m.sandbox.paypal.com`. Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a Merchant sandbox app with "Customer disputes" enabled. Several response shapes are unverified; see `docs/unverified.md`.
- `HOST` (default `127.0.0.1`) and `PORT` (default 3000) control the bind address; `.env` is loaded at startup and never overrides real environment variables.
- `ANTHROPIC_API_KEY` set: real calls to `claude-sonnet-5-5`, recorded into the cache.

## Safety model

- The agent receives only a `ReadOnlyPayPalClient` (a wrapper exposing five read methods). Write methods exist solely on the write client, which only `src/actions/approve.ts` calls. A test scans the source to enforce this.
- Approve shows the exact outbound request. The approval key becomes the `PayPal-Request-Id`, so a double click or retry cannot submit twice.
- Submitting without an approval returns 403 and is audited.
- Every tool call, draft, decision, outbound request/response and webhook is appended to a SHA-256 hash-chained audit log; `GET /audit/verify` recomputes it.
- Buyer messages reach the model only as delimited untrusted data.
- Webhooks are deduplicated by event id.

## Evidence-quality score

Deterministic, 0-100, no LLM: required evidence types, delivery verified in fetched data, grounded citations, specific notes, policy citation, 48h timeliness, minus penalties for unsupported claims and contradicted recommendations. The score is only a number for CONTEST drafts. For ACCEPT and OFFER_PARTIAL it is reported as "n/a, not contesting" (the per-part breakdown and penalties are still shown), because it would only measure how well-formed the draft is, not evidence strength. It is separate from the model's stated confidence.

## Known limitations

- Cached drafts are scripted demo fixtures, not real model output. Record real ones with an API key.
- The eval has no baseline yet, and replay numbers are not model performance.
- No authentication; single merchant user.
- Sandbox response mappings are untested against real PayPal.

MIT licensed.
