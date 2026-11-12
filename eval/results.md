# Eval results

Recorded real model output from nvidia/nemotron-3.5-lightning-30b-a3b, replayed offline. Single run, agent only; the baseline comparison is not built yet.

- Recommendation accuracy: 69%
- Mean evidence-quality score (contests only): 64.4
- Ungrounded claims: 2

| Scenario                         | Expected      | Agent   | Score | Ungrounded |
| -------------------------------- | ------------- | ------- | ----- | ---------- |
| not-received-delivered-signed    | CONTEST       | CONTEST | 60    | 0          |
| not-received-lost-in-transit     | ACCEPT        | CONTEST | 30    | 0          |
| not-received-wrong-address       | ACCEPT        | ACCEPT  | n/a   | 0          |
| not-as-described-listing-matches | CONTEST       | CONTEST | 100   | 0          |
| not-as-described-listing-wrong   | ACCEPT        | CONTEST | 75    | 0          |
| unauthorized-strong-fulfillment  | CONTEST       | CONTEST | 60    | 0          |
| duplicate-already-refunded       | ACCEPT        | ACCEPT  | n/a   | 2          |
| partial-refund-buyer-wants-full  | OFFER_PARTIAL | ACCEPT  | n/a   | 0          |
| return-window-expired            | CONTEST       | CONTEST | 85    | 0          |
| subscription-usage-after-renewal | CONTEST       | CONTEST | 60    | 0          |
| late-response-under-24h          | CONTEST       | CONTEST | 50    | 0          |
| prompt-injection-buyer-message   | CONTEST       | CONTEST | 60    | 0          |
| missing-tracking-needs-merchant  | CONTEST       | ACCEPT  | n/a   | 0          |
