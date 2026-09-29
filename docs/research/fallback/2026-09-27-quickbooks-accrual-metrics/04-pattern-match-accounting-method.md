---
name: "Match the Accounting Method — read Preferences.ReportPrefs.ReportBasis, then pin accounting_method (and label it)"
topic: "tool-catalog"
tags: ["pattern:recommended", "quickbooks", "accounting-basis", "accrual-cash", "reports-api", "basis-labeling"]
summary: "Intuit's own documented best practice: never assume a basis — query Preferences.ReportPrefs.ReportBasis and pass that value (or a deliberate override) into accounting_method, then surface the basis you actually used in the output artifact. This is the single remediation that fixes the class of bug where a computed metric silently uses a different basis than the CFO expects."
importance: 8
type: pattern
data_quality: verified
---

# content

name: Match the Accounting Method (+ record the basis in the artifact)
description: Intuit's Reports API computes on a basis you either pass or inherit. Inheriting the company preference invisibly is the root of most accrual/cash confusion when an app reports numbers to a human.

how_it_works:
  - 1. Read the company's report preference: `GET /v3/company/{realmId}/preferences` → `ReportPrefs.ReportBasis` (values Accrual | Cash).
  - 2. Pass it explicitly into the report request (`accounting_method=<value>`) — or deliberately override to the basis the metric definition requires.
  - 3. Read back `Header.ReportBasis` from the response and ASSERT it equals what you requested — fail loudly on mismatch rather than emitting a number under the wrong label.
  - 4. Stamp the basis (and the report name, date range, and Preferences read time) into every output artifact / metric row so the recipient can see which basis produced the number.

strengths:
  - Eliminates the invisible-basis failure mode at its source; deterministic and cheap
  - Makes the basis auditable — a CFO can tie a metric to a specific report and basis
  - Recommends asserting the echoed ReportBasis, catching API-side surprises

weaknesses:
  - Depends on the caller honouring it; a connector that hides the basis (see the Anthropic connector finding) cannot implement this
  - Preferences can change; the stored default can drift from what a metric was defined under — hence step 4's timestamp
  - Cash-basis report quality varies (community reports that some cash-basis QBO reports are "lacking" / mis-apply journal entries) — matching to cash does not guarantee the cash view is what the CFO means

references:
  - Intuit Developer blog — "3. Match the Accounting Method … Query the Preferences entity first … Then pass that value into your report request via the accounting_method parameter." https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c
  - Intuit Run-reports workflow — best practice #3 https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports
  - Intuit help — "How to set the report basis?" ("use the accounting_method query parameter to set either to cash or accrual") https://help.developer.intuit.com/s/question/0D50f00004o47LPCAY/how-to-set-the-report-basis

source:
  - Intuit Developer (official) troubleshooting blog
  - Intuit Run-reports API workflow
  - Intuit developer community answer

confidence: HIGH — this is documented best practice in an official Intuit source, and it directly addresses the reported failure.

sources:
  - https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c (PRIMARY-adjacent)
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (PRIMARY)
  - https://help.developer.intuit.com/s/question/0D50f00004o47LPCAY/how-to-set-the-report-basis (PRIMARY — community answer)
