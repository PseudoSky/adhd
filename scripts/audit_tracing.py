#!/usr/bin/env python3
"""Audit an `@adhd/agent-plugin-tracing` sink (backlog 5dff26e6 AC3).

Recomputes, from the durable JSONL records alone, the per-operation sample count and duration of
every agent span path and fails when a DECLARED path reported zero samples -- i.e. when the plugin
silently stopped emitting for an operation it is supposed to trace.

A *sample* is a terminal record (`<path>.finish` or `<path>.error`); `duration_ms` is read from it.
`<path>.start` records are counted separately so a hung span (start without a terminal) is visible.

Usage:
    python3 scripts/audit_tracing.py SINK [SINK ...] [--declared a,b,c] [--json]

SINK is a `.jsonl` file or a directory searched recursively for `*.jsonl`.

Exit status: 0 healthy; 1 a declared path has zero samples (or a sink had no usable records);
2 usage / unreadable input.

Standard library only.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

# The span paths `CORE_MAPPINGS` in packages/agent/agent-plugin-tracing/src/lib/mappings.ts emits.
# `packages/agent/agent-plugin-tracing/src/lib/audit-declared.test.ts` fails if this list drifts
# from that table.
DECLARED_PATHS = (
    "agent.session",
    "agent.task",
    "agent.model_call",
    "agent.tool_call",
    "agent.permission.decision",
    "agent.hitl.suspend",
    "agent.hitl.resume",
)
TERMINALS = ("finish", "error")


def iter_files(sinks: list[str]) -> list[Path]:
    files: list[Path] = []
    for sink in sinks:
        p = Path(sink)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.jsonl")))
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(sink)
    return files


def audit(files: list[Path], declared: list[str]) -> dict:
    starts: dict[str, int] = defaultdict(int)
    samples: dict[str, list[float]] = defaultdict(list)
    errors: dict[str, int] = defaultdict(int)
    malformed = 0
    total = 0
    for f in files:
        with f.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    malformed += 1
                    continue
                event = rec.get("event")
                if not isinstance(event, str) or not event.startswith("agent."):
                    continue
                total += 1
                path, _, kind = event.rpartition(".")
                if kind == "start":
                    starts[path] += 1
                elif kind in TERMINALS:
                    dur = rec.get("duration_ms")
                    samples[path].append(float(dur) if isinstance(dur, (int, float)) else 0.0)
                    if kind == "error":
                        errors[path] += 1
    paths = sorted(set(declared) | set(starts) | set(samples))
    ops = {}
    for p in paths:
        durs = samples.get(p, [])
        ops[p] = {
            "declared": p in declared,
            "starts": starts.get(p, 0),
            "count": len(durs),
            "errors": errors.get(p, 0),
            "total_ms": round(sum(durs), 3),
            "mean_ms": round(sum(durs) / len(durs), 3) if durs else 0.0,
            "max_ms": round(max(durs), 3) if durs else 0.0,
        }
    zero = [p for p in declared if ops[p]["count"] == 0]
    return {"records": total, "malformed": malformed, "operations": ops, "zero_sample_declared": zero}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("sinks", nargs="+", help="sink .jsonl file(s) or directories")
    ap.add_argument("--declared", help="comma-separated span paths that MUST have samples (default: all core paths)")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = ap.parse_args(argv)
    declared = [d.strip() for d in args.declared.split(",") if d.strip()] if args.declared else list(DECLARED_PATHS)
    try:
        files = iter_files(args.sinks)
    except (FileNotFoundError, OSError) as exc:
        print(f"audit_tracing: cannot read sink: {exc}", file=sys.stderr)
        return 2
    try:
        report = audit(files, declared)
    except OSError as exc:
        print(f"audit_tracing: cannot read sink: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"{'operation':<28} {'starts':>6} {'count':>6} {'errors':>6} {'mean_ms':>10} {'max_ms':>10}")
        for p, o in report["operations"].items():
            flag = "  <-- ZERO SAMPLES" if p in report["zero_sample_declared"] else ""
            print(f"{p:<28} {o['starts']:>6} {o['count']:>6} {o['errors']:>6} {o['mean_ms']:>10} {o['max_ms']:>10}{flag}")
        print(f"records={report['records']} malformed={report['malformed']} files={len(files)}")
    if report["records"] == 0:
        print("audit_tracing: FAIL no agent.* records in the sink(s)", file=sys.stderr)
        return 1
    if report["zero_sample_declared"]:
        print("audit_tracing: FAIL declared path(s) with zero samples: " + ", ".join(report["zero_sample_declared"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
