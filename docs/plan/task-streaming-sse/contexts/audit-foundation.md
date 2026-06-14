# audit-foundation

**Phase:** engine · **Depends on:** stream-task-tool · **Guard:**
```bash
python3 docs/plan/task-streaming-sse/scripts/audit_sse.py --phase foundation; test $? -eq 0
```

---

## Goal

Run the automated acceptance-criteria audit across all foundation states (stream-event-bus,
stream-http-server, stream-orchestrator, stream-task-tool). All checks must pass before human review.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_sse.py --phase foundation`. Verify all checks green.
- **No file mutations** — audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_sse.py --phase foundation` exits 0.

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-streaming-sse/scripts/audit_sse.py"]
```
