# Demo video script (target 2:40, hard cap 2:55)

Third-party listings say the video must be public on YouTube and under 3 minutes. Confirm in the official rules.

## Which mode, and why

Case PP-R-BVH-10197979 is now UNDER_REVIEW after the write test, so it has no action links and cannot be approved again. Do not use it for the pre-submission state.

- Shots 1-3 (inbox, case, draft): `MODE=sandbox` on a fresh sandbox dispute (steps below). This shows a real PayPal read.
- Shot 4 (approve): do it on the fresh dispute only if you accept a second real write (tracking number is a labelled placeholder). Otherwise approve in `MODE=mock`.
- Mock-mode tour (13 seeded scenarios, accept and partial-offer paths): `MODE=mock`. These are the only places accept/offer drafts and writes appear; say they are mock.

If the fresh dispute is not ready in time, record everything in `MODE=mock` and say so on camera. Never present mock as sandbox.

## Fresh dispute steps (user does these, in PayPal sandbox)

1. Sign in to the sandbox personal (buyer) and business (merchant) accounts in separate browser profiles.
2. Buyer pays the business account (card funding if you want chargeback eligibility).
3. Buyer files a "not received" case in Resolution Center.
4. Wait a few minutes. Check the dispute appears via the app inbox in sandbox mode and shows WAITING_FOR_SELLER_RESPONSE with a provide-evidence link. If it is in another state, you may need the sandbox require-evidence call (unverified; do it yourself, not via this repo).
5. Note the new dispute id for the video.

## Pre-recording checklist

- Fresh clone or clean `git status`; `npm test`, `npm run typecheck`, `npm run lint` pass.
- `npm run seed` for mock; `HOST` left at `127.0.0.1`; browser at `http://127.0.0.1:3000`.
- Never open `.env` or the sandbox dashboard credentials on screen. Keep the terminal off screen or clear it; env vars and tokens must not show. Hide bookmarks, other tabs, notifications.
- Do not show PayPal sandbox account passwords or client secret.
- Browser zoom 110-125%, window 1920x1080, mouse visible.
- Do a full dry run; time it. Rehearse the sandbox draft first and check what it shows when there is no tracker.
- Have `docs/unverified.md` ready for the closing shot.

## Shots

0:00-0:15 Hook (face or title card, voice only). Say: "Merchants lose disputes by missing evidence deadlines. Dispute Copilot drafts the response, and a human approves every send." No numbers.

0:15-0:35 Inbox (sandbox). Show the SANDBOX badge and the real dispute in the ranked list. Say it is ranked by urgency times an estimated value, an estimate and not a PayPal prediction.

0:35-1:00 Case file. Click the dispute. Show buyer, amount, transaction from the real capture. Point at "Not available" for fields PayPal did not return. Say that honestly.

1:00-1:30 Draft. Click "Draft with agent". Show the tool-call trace, then the draft and score breakdown. Point at the "Scripted demo fixture" chip and say clearly: no Anthropic key was available, this draft is a scripted fixture, not real Claude output. Show a missing-evidence flag.

1:30-2:00 Approval. Open the approval sheet and show the exact outbound request and `PayPal-Request-Id`. Say: CSRF-protected, bound to this draft version, one atomic send. Click "Approve & send". Show the result: status moves to UNDER_REVIEW (if sandbox write) with the receipt. Say the tracking number is a labelled placeholder.

2:00-2:20 Safety. Open `/audit/verify` and show it passes. One sentence: hash-chained log with an anchored head; the agent has a read-only client, and an unapproved submit returns 403. Optionally show the mock accept-claim or partial-offer scenario, labelled mock.

2:20-2:40 Honest close. Show `docs/unverified.md`: verified against sandbox (read, provide-evidence JSON), unverified (file upload, accept, offer, webhooks). Say next steps: live Claude run and real eval. Show repo link and licence.

## Avoid

- Calling the fixtures Claude output, or quoting eval numbers as model performance.
- Claims about real merchants, savings or win rates.
- Showing `.env`, tokens, client secret, sandbox passwords, or the terminal with env output.
- Clicking approve twice on a real sandbox dispute you still need.
