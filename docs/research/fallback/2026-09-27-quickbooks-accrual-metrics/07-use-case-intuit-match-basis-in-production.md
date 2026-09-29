---
name: "Intuit's own Reports-API integration guidance — match basis, chunk dates, reconcile (production pattern)"
topic: "tool-catalog"
tags: ["use-case:reference", "quickbooks", "reports-api", "compliance-date", "reconciliation", "production"]
summary: "Intuit's official developer guidance describes the exact production pattern for avoiding report mismatches: read Preferences.ReportPrefs.ReportBasis and pass it via accounting_method; understand that reports place transactions by COMPLIANCE date, not TxnDate (a prepayment's date is pushed to the invoice date); chunk to ≤6 months to stay under the 400k-cell cap; use summary for UI and detail for drill-down; use the Definition endpoint to avoid silent failures from invalid columns. This is the reference implementation for the build."
importance: 7
type: use_case
data_quality: verified
---

# content

name: Intuit's documented production pattern for the QBO Reports API
description: How Intuit itself says to consume report data reliably — the reference for a correct integration.

context: The Reports API is not raw rows; it is a report engine that computes on the company's accounting settings, so identical queries can differ by basis and by compliance-date placement.

approach:
  - Match basis: GET Preferences → ReportPrefs.ReportBasis; pass accounting_method; never let a default silently decide the basis
  - Respect compliance dates: for a prepayment (payment before invoice) the payment's compliance date is pushed to the invoice date — so a transaction can land in a different period than its TxnDate; verify filters against this when reconciling
  - Chunk dates to ≤6 months per request; handle the 400,000-cell cap ("Unable to display more data. Please reduce the date range.") by merging monthly/quarterly responses in the app
  - Summary for UI, detail for deep-dive/export: run the Summary report for overviews and the column-heavy Detail report only on demand (25+ columns → 504)
  - Use qzurl=true to get per-cell deep links so users can drill from a summary to the underlying transactions
  - Verify column names against the Definition endpoint before requesting them (invalid columns → silent failures / empty cells)
  - Use showrows=all / showcols=all when zero-balance or inactive rows matter

key_takeaway: The correct integration mirrors Intuit's own guidance exactly — pin the basis explicitly, expect compliance-date period placement, chunk for the cell cap, and reconcile summary against detail. This is fully achievable through the raw Reports API and NOT through the Anthropic connector, which hides the basis.

source: https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c (+ https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports)
data_quality: verified
tags: [use-case:reference, quickbooks, reports-api, compliance-date, reconciliation, production]

confidence: HIGH — both are Intuit-authored sources.

sources:
  - https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c (PRIMARY-adjacent, official Intuit Developer blog)
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (PRIMARY)
