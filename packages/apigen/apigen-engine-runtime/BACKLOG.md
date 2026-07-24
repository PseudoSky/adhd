### BUG-APIGEN-PARITY-NEGCTRL-STALE-001 — apigen parity harness negative-control patch no longer applies (RED teeth unverified)

**Status:** OPEN

audit-final log: proveNegativeControl in parity-harness.ts applies a patch to py-grpc/src/lib/plugin.ts:264 that fails (patch does not apply) after the DRY refactor (407fdab8) moved that source. A negative control that cannot apply proves no RED teeth, so the parity fail-when-broken guarantee is unverified. Refresh the patch anchor.
