---
name: "QuickBooks Online native Custom Report Builder / calculated fields — can't compute board SaaS metrics"
topic: "tool-catalog"
tags: ["agent:blocked", "quickbooks", "custom-reports", "dashboards", "calculated-fields", "saas-metrics"]
summary: "QBO Advanced's Custom Report Builder and calculated fields can add custom rows/columns, but only from rows/columns ALREADY visible on a single report; they do not apply to totals/sub-totals; there are no cross-source joins, no multi-entity consolidation, and no SaaS-KPI primitives. QBO natively cannot compute CAC, burn multiple, Rule of 40, NRR, or pipeline coverage. Sharing is to QBO seats / accounting team, or export to PDF/DOCX/Sheets — there is no read-only link for a CEO with no QBO seat. Blocked for board-metric computation."
importance: 7
type: tool
data_quality: verified
---

# content

name: QuickBooks Online native reporting — Custom Report Builder, calculated fields, management reports, dashboards

what_it_can_do:
  - Standard reports (P&L, Balance Sheet, Cash Flow, Trial Balance, GL, A/R & A/P aging, sales by customer/product) are customizable: dates, columns, filters, basis (Accrual/Cash), dimensions (class/location/customer/vendor/item)
  - Calculated fields (QBO Online Advanced / Intuit Enterprise Suite): add a custom row or custom column with a formula of type %, Num, or Currency
  - Management reports: package multiple reports into a board-style narrative
  - Totals/sub-totals remain sums of the underlying rows regardless of calculated fields

hard_limitations:
  - Calculated fields "can only use rows and columns that are visible on the report as input variables" — no external data
  - "Calculated fields won't apply to the totals and sub-totals shown on the report. The totals on the report will remain the sum of the prior rows." (Intuit help, verbatim)
  - No cross-source joins, no multi-entity consolidation, no bespoke computed metrics on basic tiers
  - Documented ceilings on chart-of-accounts depth, custom fields (e.g. "three per document type" in some comparisons), classes/locations (limited below Advanced)
  - Large/long-range reports crash or must be chunked (year-long and multi-year reports time out)

what_it_cannot_compute (board/CEO metrics — all require data QBO does not hold):
  - CAC / LTV / CAC payback — needs marketing spend + sales data, not on QBO reports
  - Burn multiple — needs net cash burn AND net new ARR, plus a definition
  - Rule of 40 — needs growth % and FCF/profit margin; partly QBO-capable but requires definition and cross-statement assembly
  - Net revenue retention (NRR/NDR) — needs cohort/subscription data
  - Pipeline coverage / bookings — CRM data, not QBO

sharing:
  - Custom reports can be shared with the accounting team (firm-wide or private) — recipient must have QBO access
  - Management reports are viewable only by their creator; share by email/export as PDF/DOCX, or via spreadsheet-sync connectors
  - There is NO native read-only link viewable by a CEO who has no QBO seat; external visibility requires an export or a third-party dashboard tool

use_cases:
  - Native board-ready standard statements (P&L/BS/CF) with a few computed rows
  - NOT a computation engine for SaaS board metrics

quality_signals:
  feature_gate: QBO Online Advanced / Intuit Enterprise Suite for Custom Report Builder + calculated fields
  calculated_field_inputs: only rows/columns visible on the report
  calculated_field_totals: not applied to totals/sub-totals
  external_share_readonly_link: none
  multi_entity_consolidation: not native (needs Intuit Enterprise Suite multi-entity or an add-on)
data_quality: verified
metrics_source:
  calculated_fields_limits: "fetch https://quickbooks.intuit.com/learn-support/en-us/help-article/customize-reports/add-calculated-fields-standard-custom-reports/L4gu3yYID_US_en_US"
  sharing_model: "fetch https://quickbooks.intuit.com/learn-support/en-us/help-article/accountant-reports/manage-share-custom-reports-quickbooks-online/L2luznne3_US_en_US"
  reporting_limitations: "fetch https://coefficient.io/quickbooks/limitations-in-quickbooks-online-reporting"

blocking_rationale: "Blocked as the place to compute board metrics: the builder cannot join non-QBO data (CAC/NRR/pipeline), cannot compute across sources, ignores totals in calculated fields, and has no read-only external sharing for a seatless CEO. It solves native on-report arithmetic — a different problem from SaaS board-metric computation."

confidence: HIGH (limits and sharing model come from Intuit's own help pages). MEDIUM on the exact custom-field ceiling across tiers (from a secondary comparison).

sources:
  - https://quickbooks.intuit.com/learn-support/en-us/help-article/customize-reports/add-calculated-fields-standard-custom-reports/L4gu3yYID_US_en_US (PRIMARY)
  - https://quickbooks.intuit.com/learn-support/en-us/help-article/accountant-reports/manage-share-custom-reports-quickbooks-online/L2luznne3_US_en_US (PRIMARY)
  - https://quickbooks.intuit.com/learn-support/en-us/help-article/customize-reports/customize-reports-quickbooks-online/L0gKmSawG_US_en_US (PRIMARY)
  - https://coefficient.io/quickbooks/limitations-in-quickbooks-online-reporting (SECONDARY)
  - https://www.definite.app/blog/quickbooks-custom-reporting (SECONDARY)
