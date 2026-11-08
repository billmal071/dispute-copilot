# Dispute Copilot: design brief (go hard)

Goal: a UI a judge remembers after a 3-minute video. It must look like a shipped product from a serious fintech team, not a template. Solo entrant competing with 30k registrants, so craft is a differentiator.

## Direction

- Pick ONE strong, specific visual identity and commit (frontend-design skill: no default admin look, no purple gradients, no generic card grid). Suggested: calm, high-contrast "case file / evidence desk" feel with confident typography, a tight custom palette, and one signature motif (for example a deadline clock ring and an evidence "ledger" with check marks).
- Real type system (a distinctive display face plus a clean text face, self-hosted, no CDN), tabular numerals for money, deliberate spacing scale, dark and light, motion that explains state (draft streaming in, score filling, approval stamp), respects prefers-reduced-motion.
- Accessible: WCAG AA contrast, visible focus, keyboard approval flow, semantic landmarks.

## Screens

1. Inbox: sorted by urgency x expected value, not a plain table. Each row shows deadline ring, amount, reason, win chance, and agent state. Pre-drafted seeded disputes so the demo opens populated. A top strip with money at stake, due soon, estimated recoverable.
2. Dispute (HERO): split view. Left: the case (buyer claim, transaction, shipment, order, access logs) with the evidence that matters highlighted. Right: the agent's draft, a live "win chance" gauge with the breakdown, an evidence checklist (have / missing / weak) with missing items flagged and what to collect, and the reasoning trace collapsed but inspectable. Editable notes inline.
3. Approval: one prominent action. A sheet shows the EXACT outbound PayPal request (endpoint, body, request id) before send, with an explicit approve and a clear cancel. After approval show a sent state and the audit entry.
4. Audit: timeline with chain-verified badge.
5. Honesty: in zero-credential mode label the draft source as "Scripted demo fixture" and in live mode show the model name. Never imply fixtures are real model output.

## Constraints

Keep every server behaviour and security fix (CSRF token, draft id+version on approval, 127.0.0.1 binding). htmx plus server-rendered stays; no heavy SPA. No CDN. Keep all tests green and add tests for any new view logic. Verify visually with screenshots at 1440 and 390 widths, light and dark, and check the empty, error and loading states.
