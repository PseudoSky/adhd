---
name: "Derived-metric tie-out — reconcile a computed metric to source report lines + a signed metric-definitions doc"
topic: "tool-catalog"
tags: ["pattern:recommended", "reconciliation", "derived-metrics", "board-metrics", "metric-definitions", "quickbooks"]
summary: "Metrics that are DERIVED (burn, runway, Rule of 40, NRR) are not report lines and can never be tied out by reading a report. The accepted technique: (1) pin each input to a basis-labeled source report line, (2) show the formula and the inputs in the artifact so the CFO can reproduce it, (3) reconcile aggregate inputs to QBO's own report totals (and to transaction detail / JournalReport where a number is contested), and (4) freeze definitions in a signed-off metric-definitions document."
importance: 8
type: pattern
data_quality: estimated
---

# content

name: Derived-metric tie-out (source-line reconciliation + definitions doc)
description: How to make a computed metric independently verifiable by a CFO who does not trust the tool.

how_it_works:
  - 1. For each derived metric, name the exact source report line(s) and basis it draws from (e.g. "Net burn = opening cash − closing cash, cash basis, from Balance Sheet bank accounts and/or CashFlow").
  - 2. Emit the formula AND the resolved inputs alongside the result, so the CFO can recompute it by hand.
  - 3. Reconcile inputs to QBO's own report totals: pull the summary report AND the detail report for the same period (e.g. ProfitAndLoss vs ProfitAndLossDetail, or GeneralLedger / JournalReport) and assert the aggregate equals the report's own Summary row. Use `qzurl=true` quick-zoom links so the reader can drill from a summary cell to the exact transactions.
  - 4. Freeze metric definitions in one signed-off document (name, formula, basis, source report, owner, date) — so a metric disagreement becomes a definition change, not a mystery number.
  - 5. Carry a reconciliation note per metric: "ties to <ReportName>, <basis>, <dates>; variance <n> explained by <deferred revenue / accrual timing>".

strengths:
  - Turns an untrustworthy number into a reproducible one — the reader can verify without trusting the tool
  - Detail reports (P&L Detail, GeneralLedger, TransactionList, JournalReport) provide the ground truth to reconcile against
  - A definitions doc converts recurring "the number is wrong" arguments into one-time definition decisions

weaknesses:
  - Detail reports are heavier (cell cap, column count, 504 risk) — reconcile selectively, not on every run
  - Some inputs (CAC numerator: marketing spend; NRR: cohort data) live outside QBO entirely, so those metrics can only be tied to their non-QBO sources, never to a QBO line
  - The compliance-date rule (a transaction can appear in a different period than its TxnDate) can make a period-scoped tie-out fail for legitimate reasons — chunk by period and document the rule
  - A definitions doc can go stale; it needs an owner and a review cadence

references:
  - Intuit Developer — strategic detail vs summary, Definition endpoint, qzurl drill-down, compliance-date caveat https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c
  - Intuit Run-reports — qzurl / verify against filters https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports
  - StartupCFO — "Reconcile ARR to your books … If you cannot reconcile it, neither can a diligence team." https://www.startupcfo.ai/insights/bookings-billings-revenue-arr

source:
  - Intuit Developer (official) reports/troubleshooting blog
  - StartupCFO practitioner guidance

confidence: MEDIUM. Source-line reconciliation and definitions-documentation are standard finance practice and appear in the cited practitioner/official sources, but no single authoritative standard prescribing the exact mechanism was found.

sources:
  - https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c (PRIMARY-adjacent)
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports (PRIMARY)
  - https://www.startupcfo.ai/insights/bookings-billings-revenue-arr (SECONDARY)
