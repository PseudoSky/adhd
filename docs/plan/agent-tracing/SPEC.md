# SoX tracing agent plugin — architecture spec

> **Provenance.** Source: architect spec (LOCKED). Dispatch: `dispatch-2026-10-04-9c4e`.
> Written: 2026-10-06. Plan: `FEAT-AGENT-TRACING` (`5b98d3b2`) + children TRACE-1..5.
> This is the design source for the SoX tracing agent plugin; the architecture below is not
> re-opened here.

## What
A new agent-family plugin `@adhd/agent-plugin-tracing` instruments every agent operation via the existing hook registry and emits durable **traces + derived metrics** into `@adhd/sox-telemetry` (the ecosystem tracing/metrics substrate; NOT graph-store/memory). Enabled **globally** (regular dependency of agent-mcp + `defaultPluginEntries()`), with **NO env feature toggle** (adhd ADR-0001 / sox ADR-0013). Architecturally it is the same mechanism as `agent-plugin-budget`.

## Substrate
`@adhd/sox-telemetry` (v0.4.1) — `initTelemetry`, `withSpan`, `log`, `withTimedEvent`, `registerSnapshotSection`, `snapshotMetrics`, `rollupMetrics`, `newTraceId`/`withTrace`, `resolveProcessRole`; writes `metrics.snapshot`/`metrics.rollup` to `~/.adhd/sox-ecosystem/<service>/logs/`.

## Hook surface (additive, at source — adhd ADR-0002)
Add to `packages/agent/agent-base-types/src/hooks.ts` (payloads + `HookEventMap` entries):
- `session:closed` (`SessionClosedPayload`)
- `permission:decision` (`PermissionDecisionPayload`: server/tool/callId/qualifiedToolName/action: PermissionAction/resolution: 'allow'|AskResolution/reason?)
- `hitl:suspend` (`HitlSuspendPayload`: kind 'request_human_input'|'permission_ask'|'escalation', parkedTaskId, resumeToken, escalatedFrom?)
- `hitl:resume` (`HitlResumePayload`: outcome 'resumed'|'approved'|'declined'|'cancelled')

## Emit sites (observational only — never alter a decision)
`agent-engine-orchestrator/src/engine/orchestrator.ts` (permission decision after gate eval; the 3 suspension points; resume on approvalPromise resolution) + `agent-store-runtime/src/store/session-store.ts` (`close()` emits `session:closed`). Each handler try/catch-isolated.

## Plugin
`@adhd/agent-plugin-tracing` (scaffold `npx nx g @adhd/workspace-codegen-nx:plugin --name=tracing --group=agent --nxLayer=logic --platform=node --access public --publish true`). `install()` → `initTelemetry({service, role: resolveProcessRole('live-service'), logSink, logDir, otel})` + `registerSnapshotSection('agent_tracing', …)`. Trace vocabulary: `agent.session.start|finish`, `agent.task.start|finish|error`, `agent.model_call.*`, `agent.tool_call.*`, `agent.permission.decision`, `agent.hitl.suspend|resume`; each record: trace_id/span_id/parent_span_id/duration_ms/outcome/agent{…}/operation blocks; args **digested** (sha256) unless `captureArgs`. Metrics: counters (sessions/tasks/tool_calls/model_calls/permission allow·ask·deny/ask outcomes/hitl/delegations/tokens), by_tool, latency_ms, delegation_depth_max — **rates derived by the reader**, never stored; snapshot on each task terminal.

## Config (agent-mcp, values only)
Typed FieldSpecs `tracing.service/logSink/logDir/captureArgs` (env `ADHD_AGENT_TRACING_*`); **NO `tracing.enabled`**.

## Global enablement (this machine)
Dependency of agent-mcp + `defaultPluginEntries()` from `env.config.tracing` ⇒ every agent-mcp process loads it, zero config. Writes to `~/.adhd/sox-ecosystem/agent-mcp/logs/`. Rollout = publish a new `@adhd/agent-mcp` (human approval).

## Spec segments & order
A hook surface → {B engine/store emits, C plugin} → D default-load wiring → E verification+docs. (Details in the filed items TRACE-1..5.)

## ACs (binary)
- a real task emits a session→task→model/tool trace with permission(allow|ask|deny) + HITL suspend/resume records into `~/.adhd/sox-ecosystem/agent-mcp/logs/`;
- `metrics.snapshot.sections.agent_tracing` derives latency/token/tool-call/denial·suspend-rate/delegation-depth; **negative control** (plugin absent) emits zero `agent.*` records;
- tracing is default-on; NO `ADHD_AGENT_TRACING_ENABLED`/`*_ENABLED` switch exists.

## Open items
(a) sox-telemetry `startSpan/endSpan` additive export (cross-repo, adhd ADR-0002) for a real OTel-SDK span tree; (b) `registerSnapshotSection` module-global-map duplicate-copy hazard (pin one hoisted `@adhd/sox-telemetry`); (c) global rollout needs a published `@adhd/agent-mcp`.

BACKLOG: umbrella `FEAT-AGENT-TRACING` (`5b98d3b2`) + TRACE-1..5.
