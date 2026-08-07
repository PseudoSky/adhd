# streaming_api.py — fixture for apigen py-grpc plugin streaming-deferral test.
#
# Exposes a single generator function so the extractor emits `streaming: true`
# for it (§4: "generators / async-generators → streaming:true"). Used ONLY to
# prove `apigen_python.grpc_server` explicitly REJECTS a streaming op with a
# clear error rather than silently mishandling it as a plain unary call
# ([fix:pygrpc-streaming-deferral] — gRPC natively supports streaming, but
# implementing it is out of scope for py-grpc-serve-split).

# NO `from __future__ import annotations` -- keep annotations evaluated eagerly.

from typing import Iterator

__all__ = ["stream_ints"]


def stream_ints(count: int) -> Iterator[int]:
    """Yield integers from 0 up to (but excluding) ``count``.

    Args:
        count: Number of integers to yield.

    Yields:
        Successive integers ``0, 1, ..., count - 1``.
    """
    for i in range(count):
        yield i
