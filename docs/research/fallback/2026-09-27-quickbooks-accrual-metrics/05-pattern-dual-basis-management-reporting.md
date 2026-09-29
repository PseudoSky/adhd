---
name: "Dual-basis management reporting — accrual for performance, cash for liquidity, both labeled"
topic: "tool-catalog"
tags: ["pattern:recommended", "accounting-basis", "accrual-cash", "board-metrics", "management-reporting"]
summary: "Board packs that try to force every metric onto one basis fail to tie because different metrics are meaningful on different bases. The practitioner consensus: performance metrics (revenue, gross margin, NRR, Rule of 40 growth leg) on accrual/GAAP (ASC 606); liquidity metrics (burn, runway, cash) on cash; label each figure's basis; and never mix the two inside one derived formula without a bridge."
importance: 8
type: pattern
data_quality: estimated
---

# content

name: Dual-basis management reporting (and label every basis)
description: A board pack is not one basis. It is a set of metrics, each correct on its own basis, with the basis stated and the gaps bridged.

how_it_works:
  - 1. Classify each metric by basis:
      - Accrual / GAAP (ASC 606) — Revenue (recognized, ratable), gross margin, NRR/GRR, Rule of 40 growth leg, ARR (a snapshot of recurring run-rate, not a period total), bookings (a commitment, not revenue).
      - Cash — Burn (net cash change), runway, any "money in/out" figure, billings-as-collections proxy.
  - 2. Label each figure with its basis in the artifact (e.g. "Revenue (accrual, ASC 606)" vs "Net burn (cash)").
  - 3. Where a derived metric mixes the two (Rule of 40 = growth % on accrual revenue + FCF margin on cash), state the formula and that it deliberately mixes bases.
  - 4. Bridge the gap explicitly: bookings → billings → revenue → cash, with deferred revenue as the reconciliation account.

strengths:
  - Each number is meaningful on its own terms; the pack ties because the reader knows which basis each line is on
  - Matches how boards and auditors actually consume the numbers (StartupCFO: "bookings and ARR to the board, revenue to finance/auditors, billings to whoever owns runway")
  - The bookings/billings/revenue/ARR "one deal, four numbers" model is a concrete, citable bridge

weaknesses:
  - Requires discipline and a written definition set; without it the labels are ignored
  - A derived metric that mixes bases (Rule of 40, burn multiple) is definitional, not a report line — it can never be "read off" a report and must be reconciled by construction
  - Accrual and cash figures legitimately differ; a reader expecting a single tie-out will still see two totals unless the bridge is shown

references:
  - StartupCFO — "Bookings vs. Billings vs. Revenue vs. ARR" (definitions, ASC 606, which audience wants which number) https://www.startupcfo.ai/insights/bookings-billings-revenue-arr
  - NetSuite — Cash-basis vs accrual-basis https://www.netsuite.com/portal/resource/articles/financial-management/cash-basis-accrual-basis.shtml
  - RunFutureProof — "SaaS and ecommerce companies need accrual accounting for operations and investor reporting, but cash basis for tax filing" https://www.runfutureproof.com/blog/accrual-vs-cash-basis-saas-ecommerce
  - InflectionCFO — accrual-basis burn vs true cash burn divergence https://inflectioncfo.co/blog/burn-rate-runway-the-multi-currency-and-revenue-recognition-problem/

source:
  - StartupCFO (practitioner CFO advisory)
  - NetSuite (vendor thought-leadership)
  - RunFutureProof (practitioner)

confidence: MEDIUM. The accrual-for-performance / cash-for-liquidity split is repeated across independent practitioner sources and is consistent with ASC 606 (revenue recognized on delivery) — but I found NO AICPA/FASB/regulatory pronouncement prescribing a board-pack basis split, so this is strong practitioner consensus, not a standard. Do not cite it as an accounting standard.

sources:
  - https://www.startupcfo.ai/insights/bookings-billings-revenue-arr (SECONDARY — strong)
  - https://www.runfutureproof.com/blog/accrual-vs-cash-basis-saas-ecommerce (SECONDARY)
  - https://www.netsuite.com/portal/resource/articles/financial-management/cash-basis-accrual-basis.shtml (SECONDARY)
  - https://inflectioncfo.co/blog/burn-rate-runway-the-multi-currency-and-revenue-recognition-problem/ (SECONDARY)
