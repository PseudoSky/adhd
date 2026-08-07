"""Parent-death watchdog (BUG-APIGEN-053).

Both of apigen_python's long-running servers (flask_server.py, grpc_server.py)
are spawned by a TS parent (apigen-plugin-py-flask/-py-grpc's `run()`) with
stdio `['pipe', 'pipe', 'pipe']`. The only teardown path either plugin wires
is `input.signal`'s 'abort' handler, which sends SIGTERM to the child -- but
that requires the TS parent process to still be alive to fire it. When the
parent instead dies outright (SIGKILL, OOM-kill, CI job cancellation, an
uncaught crash before its abort handler runs), no signal is ever sent,
`serve_forever()`'s wait/join call never wakes up, and the process reparents
to launchd (ppid=1), holding its listening socket forever -- this is
BUG-APIGEN-053's exact, measured failure mode (132 orphaned processes / 137
listening sockets, ~23h old).

Neither Python's default SIGTERM disposition (fires only when someone SENDS
SIGTERM) nor a PR_SET_PDEATHSIG-style mechanism (Linux-only; unavailable on
macOS, where this failure was measured) closes this gap. The portable fix:
the child's stdin is a pipe whose write end is owned by the parent process.
The OS closes that write end the INSTANT the parent dies, for ANY reason,
including SIGKILL -- no cooperation from the dying parent required. A
background thread blocked reading stdin sees EOF at exactly that moment.
"""
from __future__ import annotations

import os
import threading
from typing import Callable, Optional


def start_parent_death_watchdog(
    on_parent_death: Optional[Callable[[], None]] = None,
) -> threading.Thread:
    """Starts a daemon thread blocked reading stdin (fd 0) via a raw
    `os.read()` -- see the in-loop comment for why not `sys.stdin`. On EOF
    (the parent's write end of the stdin pipe closed -- i.e. the parent
    died, for ANY reason including SIGKILL), calls `on_parent_death`.

    Default `on_parent_death` is `os._exit(0)` -- an immediate hard process
    exit. That is deliberate and safe here: there is no client left to serve
    a graceful response to (the process that spawned this server is gone),
    and the OS reclaims the listening socket on process exit regardless of
    whether `Server.stop()`/`shutdown()` ran first.

    Returns the started (daemon=True) Thread so a caller/test can join it.
    """
    callback = on_parent_death or (lambda: os._exit(0))

    def _watch() -> None:
        try:
            while True:
                # Deliberately `os.read(0, ...)` (a raw fd read via the
                # syscall wrapper), NOT `sys.stdin.buffer.read(...)`: the
                # buffered form takes CPython's internal BufferedReader lock
                # for the duration of the blocking read. `grpc_server.py`
                # handles SIGTERM/SIGINT gracefully (its own handler sets an
                # Event and `_main()` returns normally, reaching an ORDERLY
                # `Py_Finalize()`) -- and finalization tries to flush/close
                # `sys.stdin`, which cannot acquire that same lock while this
                # daemon thread still holds it, producing a real, reproduced
                # `Fatal Python error: _enter_buffered_busy: could not
                # acquire lock ... at interpreter shutdown` on every single
                # graceful teardown. A raw `os.read()` never touches that
                # lock, so it can be safely abandoned mid-call when the
                # interpreter exits either gracefully or via `os._exit()`.
                chunk = os.read(0, 4096)
                if not chunk:
                    break
        except OSError:
            # stdin fd already closed/invalid (e.g. a harness that doesn't
            # wire a pipe, or redirects fd 0 elsewhere) -- nothing to watch;
            # exit the thread quietly.
            return
        callback()

    thread = threading.Thread(
        target=_watch, name="apigen-parent-death-watchdog", daemon=True
    )
    thread.start()
    return thread
