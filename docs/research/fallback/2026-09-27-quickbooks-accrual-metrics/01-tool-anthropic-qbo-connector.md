---
name: "Anthropic Intuit QuickBooks connector — capability audit (no accounting_method control)"
topic: "tool-catalog"
tags: ["agent:blocked", "quickbooks", "claude-connector", "mcp", "accounting-basis", "accrual-cash"]
summary: "Intuit's official QuickBooks connector for Claude exposes ~74 MCP tools but NO caller-controllable accounting_method parameter — the report tools are fixed-surface (P&L, cash flow, balance sheet, A/R-A/P aging, sales by customer/product) and Intuit documents the use cases as a closed list. It cannot be driven to a chosen accrual/cash basis, and report rows are summarized.  Blocked as the basis-controllable metrics source for a board-metrics pipeline; it is a chat/analysis surface, not a programmatic reporting API."
importance: 8
type: tool
data_quality: verified
---

# content

name: Anthropic Intuit QuickBooks connector (mcp: https://ai-inc.quickbooks.intuit.com/v1/mcp)
description: Intuit's official, Intuit-hosted MCP connector that lets Claude read from and write to QuickBooks Online. Anthropic-verified; listed on the Claude Marketplace as made by Intuit QuickBooks; connector URL `https://ai-inc.quickbooks.intuit.com/v1/mcp`. Added ~March 2026. US-only at time of writing.

features:
  - ~74 tools total. Report/read tools visible in the public tool list include: `profit-loss-generator`, `cash-flow-generator`, `benchmarking-against-industry`, `profit-loss-quickbooks-account`, `cash-flow-quickbooks-account`, `benchmarking-quickbooks-account`, `company-info`, `qbo_accounting_get_balance_sheet`, `qbo_accounting_get_ar_aging_summary`, `qbo_accounting_get_ar_aging_detail`, `qbo_accounting_get_sales_by_customer_summary`, `qbo_accounting_get_sales_by_product_summary`, `qbo_accounting_get_product_service_list`
  - A large write surface: create/update/delete/duplicate invoices and estimates, create customers, create payment links, import transactions, update business profile
  - NO `accounting_method` (or equivalent Accrual/Cash) parameter is documented or exposed on any report tool. Basis control is NOT a caller-selectable input
  - Intuit's own help article enumerates the report use cases as a fixed list (P&L, cash flow, industry benchmarking, transaction import, business profile) and states verbatim: "The current QuickBooks connector use cases are limited to the ones above."
  - Reports are returned as summarized values for chat consumption, not as a raw row/cell report tree the caller can control

use_cases:
  - Conversational analysis and write-back of QuickBooks data inside Claude
  - NOT suitable as a deterministic, basis-pinned, programmatically-controlled report source for a board-metrics pipeline

quality_signals:
  endpoint: https://ai-inc.quickbooks.intuit.com/v1/mcp
  tool_count: ~74 (public page shows "Show all 74 tools")
  accounting_method_parameter: none exposed
  doc_limits: "closed list of use cases (Intuit help article)"
  hosting: Intuit servers
  region: US-only (per Intuit help article, 2026)
  pricing: included with a QuickBooks/Intuit Enterprise Suite subscription (or usable without one by pasting CSV/PDF)
data_quality: verified
metrics_source:
  tool_list_and_hosting: "fetch https://claude.com/connectors/intuit-quickbooks"
  closed_use_case_list: "fetch https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/use-quickbooks-connector-claude/L3YBlo6Ht_US_en_US"

limits:
  - No control over reporting basis (accrual vs cash) — the single most important gap for this problem
  - Report coverage is a fixed, small set; no Trial Balance, General Ledger, JournalReport, or transaction-level export surfaced
  - Output is summarized for chat; no documented row/cell cap, pagination contract, or truncation behaviour exposed to a caller (because it is not a paginated data API)
  - Rate limits are not documented publicly for the connector (it fronts Intuit servers; the underlying API limits at https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles apply upstream)

blocking_rationale: "Blocked for the board-metrics use case specifically because it cannot be told which accounting basis to use and exposes a fixed, summarized report surface. A pipeline that must produce a metric under a signed-off basis definition cannot depend on a connector that picks (or inherits) the basis invisibly. It solves conversational QBO analysis and write-back — a different problem from deterministic, reproducible, basis-pinned metric computation."

confidence: HIGH that no accounting_method parameter is documented/exposed (two independent Intuit/Anthropic-sourced pages). MEDIUM that the underlying tool schema has no hidden basis argument — the public tool list is the strongest available evidence short of inspecting a live MCP handshake.

sources:
  - https://claude.com/connectors/intuit-quickbooks (PRIMARY — Anthropic marketplace listing, tool list, connector URL)
  - https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/use-quickbooks-connector-claude/L3YBlo6Ht_US_en_US (PRIMARY — Intuit help article, closed use-case list)
  - https://www.usecarly.com/blog/claude-quickbooks-integration/ (SECONDARY)
  - https://www.recklabs.co/connectors/quickbooks (SECONDARY — a third-party QBO MCP listing, "29 tools")
