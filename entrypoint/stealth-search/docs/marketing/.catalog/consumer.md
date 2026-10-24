# Consumer test (docs only)

Four tasks attempted from README, AGENTS, llms.txt, CHANGELOG and docs/*.md only.

| Task | Result |
| --- | --- |
| 1. Register the MCP server and call the DuckDuckGo search tool | Partial before the fixes: the payload shape and `search` inputs were not documented. Addressed by the README section "Calling stealth_search over MCP" (data wrapper, request, input table, command resolution). |
| 2. Exit status 70 and the MCP form of a typed failure | Sufficient. |
| 3. Chrome host, port, profile, platform support and diagnostics without corrupting stdout | Sufficient for macOS defaults and the stderr rule. Chrome binary on macOS now stated in the README. |
| 4. CAPTCHA site and the meaning of "stealth" | Sufficient. |

Remaining gaps noted by the consumer: no documented timeout for a human challenge wait beyond `challengeWaitMs`; per-client MCP config locations; Windows and Linux profile paths (unsupported platforms).
