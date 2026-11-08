export const MERCHANT_POLICIES = {
  ref: "policy:merchant",
  merchant_name: "Loom & Lantern",
  return_policy: {
    window_days: 30,
    text: "Unused items may be returned within 30 days of delivery for a refund. The buyer pays return shipping. Items damaged by use are not eligible. Disputes opened after the window should be resolved under this policy.",
  },
  shipping_policy:
    "Physical orders ship within 2 business days with a tracked and signature-confirmed carrier service (DHL Express or UPS). We only ship to the address on the PayPal transaction.",
  terms_of_service:
    "By purchasing, the buyer agrees that listings describe the item as photographed and itemised in the order. Digital subscriptions renew automatically; cancellation must be requested before the renewal date and applies from the next period. Used subscription periods are not refundable.",
} as const;
