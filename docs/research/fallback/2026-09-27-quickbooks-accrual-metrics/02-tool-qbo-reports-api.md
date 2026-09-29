---
name: "Intuit QuickBooks Online Reports API — direct integration (accounting_method supported)"
topic: "tool-catalog"
tags: ["agent:approved", "quickbooks", "reports-api", "oauth2", "accounting-basis", "accrual-cash"]
summary: "Intuit's own Reports API (GET /v3/company/{realmId}/reports/{ReportName}) exposes `accounting_method=Accrual|Cash` on most report endpoints and returns the report's basis back in Header.ReportBasis. It is the authoritative, basis-controllable source. Requires an OAuth2 app (scope com.intuit.quickbooks.accounting), ~60-min access tokens and 100-day refresh tokens that rotate every 24-26h. Hard 400,000-cell per-response cap; 500 req/min per realm. Approved as the correct integration path."
importance: 9
type: tool
data_quality: verified
---

# content

name: QuickBooks Online Reports API (Accounting API — report entities)
description: Intuit's Reports API returns the same reports QuickBooks computes, as a recursive JSON tree of Header/Columns/Rows. Report names are case-sensitive PascalCase (a typo → HTTP 400). The API computes reports server-side ("You don't build them from raw queries — QBO computes them").

endpoint: GET /v3/company/{realmId}/reports/{ReportName}?start_date=…&end_date=…&accounting_method=Accrual|Cash&minorversion=75

features:
  - `accounting_method` — the exact parameter name; supported values `Accrual` and `Cash`. Documented on the ProfitAndLoss API reference and in the Run-reports workflow; the returned report echoes the basis in `Header.ReportBasis` (ReportBasisEnum: Cash | Accrual)
  - Default basis = the company's report preference: `Preferences.ReportPrefs.ReportBasis`. Intuit's best-practice is to read Preferences first, then pass that value into `accounting_method` (or override deliberately)
  - Common params: `start_date`, `end_date`, `date_macro` (use one OR the other, not both), `summarize_column_by` (Total, Customers, Vendors, Classes, Departments, Employees, ProductsAndServices; also Month/Quarter/Year for columnar), `columns` (comma list — request only what you display), `customer`, `vendor`, `class`, `department`, `qzurl=true` (drill-down hyperlinks), `showrows=all` / `showcols=all`, `aging_method`, `report_date`, `minorversion`
  - `Header.Option` carries `AccountingStandard` (P&L and Balance Sheet only) and `NoReportData` (every report; true = no data, structure still returned)

reports_after_modernization (29 supported — the report set as of the June-30-2026 modernized service):
  AccountListDetail, AgedPayableDetail, AgedPayables, AgedReceivableDetail, AgedReceivables, BalanceSheet, CashFlow, CustomerBalance, CustomerBalanceDetail, CustomerIncome, GeneralLedger, InventoryValuationDetail, InventoryValuationSummary, JournalReport, ProfitAndLoss, ProfitAndLossDetail, SalesByClassSummary, SalesByCustomer, SalesByDepartment, SalesByProduct, TaxSummary, TransactionList, TransactionListByCustomer, TransactionListByVendor, TransactionListWithSplits, TrialBalance, VendorBalance, VendorBalanceDetail, VendorExpenses

transaction_level_detail:
  - Reports that carry line/transaction granularity: `ProfitAndLossDetail`, `GeneralLedger`, `TransactionList`, `TransactionListByCustomer`, `TransactionListByVendor`, `TransactionListWithSplits`, `JournalReport`
  - What detail buys over aggregates: the ability to trace a summary number to the exact entries that produced it — the basis of independent CFO verification. `qzurl=true` additionally returns a deep-link URL per cell for drill-down without re-issuing detail queries
  - Cost/complexity: larger payloads (cell cap), more columns (25+ columns → 504 gateway timeouts, per Intuit's own dev blog), more parsing (recursive Section/Data Rows), and response-shape changes under the modernized service

hard_limits:
  - 400,000 cells per report response — exceeding it returns "Unable to display more data. Please reduce the date range." Mitigation: date-chunk (Intuit recommends ≤6 months per request; monthly/quarterly merges)
  - 25+ requested columns materially raises 504 / incomplete-payload risk
  - Otherwise the report engine's "compliance date" logic can place a transaction in a different period than its TxnDate (e.g. a prepayment's compliance date is pushed to the invoice date) — a real reconciliation trap

rate_limits (production, per realm ID):
  - 500 requests/minute per realm ID
  - 10 concurrent requests in one second per realm ID and app
  - 40 batch requests/minute per realm ID; max 30 payloads per batch
  - HTTP 429 on throttle; wait 60s; requests >120s time out
  - (secondary blogs also claim a lower ~200/min tier for "resource-intensive" report endpoints — NOT confirmed on Intuit's own limits page; treat as LOW confidence)

oauth:
  - Scope: `com.intuit.quickbooks.accounting` (+ `com.intuit.quickbooks.payment` for Payments)
  - Access token ≈ 60 minutes; refresh token valid ~100 days but its VALUE rotates every 24–26 hours — persist the newest refresh token or the next refresh fails with invalid_grant
  - Tokens are tied to a realmId (company). Sandbox uses separate base URLs and a sandbox company; production = quickbooks.api.intuit.com

use_cases:
  - Deterministic, basis-pinned board metrics computed from a chosen accrual or cash report
  - Pulling journal/transaction detail to reconcile a derived metric back to source lines
  - Scheduled/automated reporting via a first-party OAuth app

quality_signals:
  primary_docs: developer.intuit.com /app/developer/qbo/docs/workflows/run-reports
  api_reference: developer.intuit.com /app/developer/qbo/docs/api/accounting/most-commonly-used/profitandloss
  limits_page: help.developer.intuit.com /s/article/API-call-limits-and-throttling
  cell_limit: 400000
  reports_supported: 29
  rate_limit_prod: 500/min per realm
  oauth_scope: com.intuit.quickbooks.accounting
  token_access_ttl: ~60 min
  token_refresh_ttl: ~100 days (rotates 24–26h)
data_quality: verified
metrics_source:
  accounting_method_param: "fetch (mirror of Intuit docs) https://raw.githubusercontent.com/codegirl-007/qbo-docs/master/workflows/run-reports.md"
  api_reference_param: "google snippet of https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/profitandloss"
  cell_limit_and_columns: "fetch https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c"
  rate_limits: "fetch https://help.developer.intuit.com/s/article/API-call-limits-and-throttling"
  oauth_ttl: "fetch/search https://help.developer.intuit.com/s/article/Handling-OAuth-token-expiration"

build_vs_integrate: Integrate (build a thin first-party client over it; do not re-implement report computation)

confidence: HIGH on the exact parameter name and values (param `accounting_method`, values `Cash`/`Accrual`), the 400k cell cap, the rate-limit numbers, and OAuth TTLs — each appears in primary Intuit sources. MEDIUM on the exact current (post-June-2026) supported-report list and on the migration status, because the fetched doc mirror pre-dates the deadline while today is after it.

sources:
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (PRIMARY — fetched via mirror)
  - https://raw.githubusercontent.com/codegirl-007/qbo-docs/master/workflows/run-reports.md (mirror reproducing PRIMARY text, source_url header points at developer.intuit.com)
  - https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/profitandloss (PRIMARY — API reference; accounting_method definition)
  - https://help.developer.intuit.com/s/article/API-call-limits-and-throttling (PRIMARY — rate limits)
  - https://help.developer.intuit.com/s/article/Handling-OAuth-token-expiration (PRIMARY — token TTL/rotation)
  - https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c (PRIMARY-adjacent — official Intuit Developer blog)
  - https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalreport (PRIMARY — JournalReport entity)
