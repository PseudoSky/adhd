---
name: "QBO Reports API modernization (June 30 2026) — response-shape changes and a 29-report supported set"
topic: "tool-catalog"
tags: ["use-case:reference", "quickbooks", "reports-api", "migration", "risk", "changelog"]
summary: "Intuit migrated the Reports API to a 'modernized service' — as of the June 30 2026 deadline all report responses come from it, with documented response differences (structure, fields, row order, grouping). Only documented report endpoints survive; undocumented/list-style/transaction-detail reports many third-party dashboards relied on are dropped. Any integration (connector, API client, or third-party sync) must be re-validated against the modernized responses. This is a live churn risk that argues for controlling the integration surface directly."
importance: 7
type: use_case
data_quality: verified
---

# content

name: Reports API modernization (migration to the modernized report service, deadline June 30 2026)
description: Intuit replaced the report engine behind the Reports API; behaviour and supported reports changed.

context: The Reports API had been the "primary gateway" for P&L/BS/CF; Intuit moved it to the same modernized service that powers the newer in-product report view. Response URL and body stay the same, but output can differ, and the supported-report set narrowed.

approach / details:
  - `testing_migration=true` query param let apps test against the new service before the deadline
  - After June 30 2026 (deadline passed as of this research date, 2026-09-27) all responses are served by the modernized service
  - 29 reports supported (incl. BalanceSheet, CashFlow, ProfitAndLoss, ProfitAndLossDetail, TrialBalance, GeneralLedger, JournalReport, TransactionList{,ByCustomer,ByVendor,WithSplits}, aging reports, sales summaries, vendor/customer balance, InventoryValuation{,Summary,Detail}, AccountListDetail, TaxSummary)
  - Unsupported reports are no longer available via the API — notably many transaction-level / list-style reports some dashboards depended on (Transaction Detail, Sales by Customer Detail, Bill Payments List, Open Invoices, Class List, Product/Service List, Project Profitability, etc.)
  - Intuit warned of "response differences" — structure, fields, row order, grouping, and output behaviour may not match pre-migration output
  - Since only DOCUMENTED endpoints survive, any tool that relied on undocumented report behaviour is now at risk

key_takeaway: The report surface is actively changing. A pipeline that hardcodes a third-party connector's behaviour inherits that connector's exposure to Intuit's migration; a first-party client over the documented Reports API can be re-validated and pinned deliberately. Verify the current supported-report list and response shapes against Intuit's live docs before relying on any specific report.

source:
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (migration section)
  - https://medium.com/intuitdev/upcoming-changes-to-reports-apis-5083ec9aadce (Intuit Developer — official announcement)
  - https://www.g-accon.com/quickbooks-online-reports-api-is-changing/ (SECONDARY — vendor analysis with the affected-report list)
data_quality: verified
tags: [use-case:reference, quickbooks, reports-api, migration, risk, changelog]

confidence: HIGH that a modernization migrated the Reports API with a June 30 2026 deadline, response differences, and a 29-report supported set (Intuit-sourced). MEDIUM on the precise post-deadline current state and the exact dropped-report list (the fetched doc mirror pre-dates the deadline; today is after it — re-verify live).

sources:
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (PRIMARY, via mirror)
  - https://medium.com/intuitdev/upcoming-changes-to-reports-apis-5083ec9aadce (PRIMARY-adjacent — official Intuit Developer Medium)
  - https://www.g-accon.com/quickbooks-online-reports-api-is-changing/ (SECONDARY)
