# Eval results

Replayed scripted fixtures, so this is a cache integrity check and not a measurement of model performance. Set ANTHROPIC_API_KEY and rerun for live numbers.

- Recommendation accuracy: 100%
- Mean evidence-quality score (contests only): 91.9
- Ungrounded claims: 0

| Scenario                         | Expected      | Agent         | Score | Ungrounded |
| -------------------------------- | ------------- | ------------- | ----- | ---------- |
| not-received-delivered-signed    | CONTEST       | CONTEST       | 100   | 0          |
| not-received-lost-in-transit     | ACCEPT        | ACCEPT        | n/a   | 0          |
| not-received-wrong-address       | ACCEPT        | ACCEPT        | n/a   | 0          |
| not-as-described-listing-matches | CONTEST       | CONTEST       | 100   | 0          |
| not-as-described-listing-wrong   | ACCEPT        | ACCEPT        | n/a   | 0          |
| unauthorized-strong-fulfillment  | CONTEST       | CONTEST       | 100   | 0          |
| duplicate-already-refunded       | ACCEPT        | ACCEPT        | n/a   | 0          |
| partial-refund-buyer-wants-full  | OFFER_PARTIAL | OFFER_PARTIAL | n/a   | 0          |
| return-window-expired            | CONTEST       | CONTEST       | 100   | 0          |
| subscription-usage-after-renewal | CONTEST       | CONTEST       | 100   | 0          |
| late-response-under-24h          | CONTEST       | CONTEST       | 90    | 0          |
| prompt-injection-buyer-message   | CONTEST       | CONTEST       | 100   | 0          |
| missing-tracking-needs-merchant  | CONTEST       | CONTEST       | 45    | 0          |
