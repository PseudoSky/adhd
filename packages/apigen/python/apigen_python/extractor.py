"""
apigen_python.extractor — Python source → canonical Operation[] descriptors (SPEC §4 / §14).

Extracts every public export from a Python module and emits a list of Operation
dicts that match the canonical §4 JSON shape:

  id, host('python'), namespace, path, kind, async, streaming, safe,
  input (JSON-Schema-2020-12 object), output (JSON-Schema-2020-12),
  envelope ({} — middleware is TS-side only for now), typeText (None).

Usage (subprocess / CLI):
    python -m apigen_python.extractor <module_file_or_path> [--namespace <ns>]
    → JSON array on stdout

Rules:
- Every exported name (not starting with '_') that is callable → kind='action'.
- Every exported name that holds a serialisable primitive/dict/list → kind='query'.
- Non-serialisable, non-callable exports → skipped + warned to stderr.
- 'ctx' first-parameter is excluded from input schema (§4 inv:ctx-name-only).
- Async functions → async:true; generators / async-generators → streaming:true.
- kind='query' → safe:true by default; kind='action' → safe:false.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import os
import re
import sys
import types
import warnings
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# §4 Segment helpers
# ---------------------------------------------------------------------------

def _tokenise(raw: str) -> list[str]:
    """Tokenise a camelCase / snake_case / kebab-case name into lower-cased words.

    Examples:
        'humanizeBytes' → ['humanize', 'bytes']
        'get_user'      → ['get', 'user']
        'file-name'     → ['file', 'name']
    """
    # Insert split boundary between lower→upper transitions (camelCase).
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", raw)
    # Split on non-alphanumeric separators.
    parts = re.split(r"[^a-zA-Z0-9]+", s)
    return [p.lower() for p in parts if p]


def _seg(raw: str) -> dict[str, Any]:
    """Build a casing-neutral Segment dict from a raw token."""
    return {"raw": raw, "words": _tokenise(raw)}


def _normalise_filename(raw: str) -> str:
    """Strip extension; dots/underscores → hyphens (SPEC §5)."""
    no_ext = re.sub(r"\.[^.]+$", "", raw)
    return re.sub(r"[._]+", "-", no_ext)


# ---------------------------------------------------------------------------
# JSON-Schema inference (stdlib only — no jsonschema dependency for extraction)
# ---------------------------------------------------------------------------

def _py_type_hint_to_schema(annotation: Any) -> dict[str, Any]:
    """Best-effort conversion of a Python type annotation to JSON Schema 2020-12.

    Only covers the common cases; falls back to {} (any) for complex generics.
    Returns a plain dict.
    """
    import typing

    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", ())

    # None / NoneType
    if annotation is type(None):
        return {"type": "null"}

    # Primitives
    _primitives: dict[Any, str] = {
        str: "string",
        int: "integer",
        float: "number",
        bool: "boolean",
        bytes: "string",
    }
    if annotation in _primitives:
        return {"type": _primitives[annotation]}

    # typing.Optional[X] == Union[X, None]
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1 and type(None) in args:
            inner = _py_type_hint_to_schema(non_none[0])
            return {"oneOf": [inner, {"type": "null"}]}
        schemas = [_py_type_hint_to_schema(a) for a in args]
        return {"oneOf": schemas}

    # list / List[T]
    if origin is list:
        items = _py_type_hint_to_schema(args[0]) if args else {}
        return {"type": "array", "items": items}

    # dict / Dict[K, V]
    if origin is dict:
        value_schema = _py_type_hint_to_schema(args[1]) if len(args) > 1 else {}
        return {"type": "object", "additionalProperties": value_schema}

    # dataclasses.dataclass
    try:
        import dataclasses
        if dataclasses.is_dataclass(annotation) and isinstance(annotation, type):
            props: dict[str, Any] = {}
            required: list[str] = []
            for f in dataclasses.fields(annotation):
                props[f.name] = _py_type_hint_to_schema(f.type)
                if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:  # type: ignore[misc]
                    required.append(f.name)
            schema: dict[str, Any] = {"type": "object", "properties": props}
            if required:
                schema["required"] = required
            return schema
    except Exception:
        pass

    # Fall back: open object schema (any)
    return {}


def _params_to_input_schema(sig: inspect.Signature) -> dict[str, Any]:
    """Convert a function's signature to a §4 input JSON-Schema object.

    - Excludes the first parameter named 'ctx' (§4 inv:ctx-name-only).
    - Each remaining parameter becomes a property.
    - Parameters without defaults are required.
    """
    props: dict[str, Any] = {}
    required: list[str] = []

    params = list(sig.parameters.values())
    # Drop 'self' for bound methods.
    if params and params[0].name == "self":
        params = params[1:]
    # Drop 'ctx' first-param (name-only match, SPEC §4).
    if params and params[0].name == "ctx":
        params = params[1:]
    # Drop *args / **kwargs from schema (not serialisable as named params).
    named = [
        p for p in params
        if p.kind not in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        )
    ]

    for p in named:
        ann = p.annotation
        if ann is inspect.Parameter.empty:
            schema_frag: dict[str, Any] = {}
        else:
            schema_frag = _py_type_hint_to_schema(ann)
        props[p.name] = schema_frag
        if p.default is inspect.Parameter.empty:
            required.append(p.name)

    result: dict[str, Any] = {"type": "object", "properties": props}
    if required:
        result["required"] = required
    return result


def _return_to_output_schema(sig: inspect.Signature) -> dict[str, Any]:
    """Convert a function's return annotation to a §4 output JSON-Schema.

    Promise<T> / Awaitable[T] and generator wrappers are unwrapped to T.
    """
    ann = sig.return_annotation
    if ann is inspect.Parameter.empty:
        return {}
    # Unwrap Coroutine / Awaitable / Generator wrappers.
    import typing

    origin = getattr(ann, "__origin__", None)
    # AsyncGenerator[T, ...] → T
    if origin is not None:
        name = getattr(origin, "__name__", "") or getattr(origin, "_name", "")
        if name in ("AsyncGenerator", "Generator", "AsyncIterator", "Iterator"):
            args = getattr(ann, "__args__", ())
            if args:
                return _py_type_hint_to_schema(args[0])
    # Coroutine[_, _, T] → T
    try:
        if origin is not None and hasattr(origin, "__name__") and origin.__name__ == "Coroutine":
            args = getattr(ann, "__args__", ())
            if len(args) >= 3:
                return _py_type_hint_to_schema(args[2])
    except Exception:
        pass

    return _py_type_hint_to_schema(ann)


# ---------------------------------------------------------------------------
# Operation building
# ---------------------------------------------------------------------------

def _is_streaming(fn: Any) -> bool:
    """True if the function is an async generator or regular generator."""
    return inspect.isasyncgenfunction(fn) or inspect.isgeneratorfunction(fn)


def _is_async(fn: Any) -> bool:
    """True if the function is a coroutine function or async generator."""
    return inspect.iscoroutinefunction(fn) or inspect.isasyncgenfunction(fn)


def _is_serialisable(value: Any) -> bool:
    """Cheaply check if a non-callable export can be JSON-serialised."""
    try:
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


def _derive_id(namespace_raw: str, path: list[dict[str, Any]]) -> str:
    """Derive the canonical §4 id: namespace/path (kebab-joined).

    Mirrors the TS implementation: namespace slug + "/" + path segments joined
    with "/" where each segment is tokenised words joined with "-".
    """
    def seg_to_slug(s: dict[str, Any]) -> str:
        return "-".join(s["words"])

    parts = [namespace_raw] + [seg_to_slug(s) for s in path]
    return "/".join(parts)


def extract_module(
    module_path: str,
    namespace: str | None = None,
) -> list[dict[str, Any]]:
    """Extract Operation descriptors from a Python source file.

    Args:
        module_path: Absolute or relative path to the .py file.
        namespace: The §4 namespace slug. Defaults to the file stem.

    Returns:
        List of Operation dicts (§4 JSON shape).
    """
    path = Path(module_path).resolve()
    file_stem = path.stem

    # Normalise the file segment: strip extension, dots/underscores → hyphens (SPEC §5).
    norm_file = _normalise_filename(path.name)
    ns_raw = namespace or norm_file
    namespace_seg = _seg(ns_raw)

    # Dynamically import the module.
    spec = importlib.util.spec_from_file_location("_apigen_target_", str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    operations: list[dict[str, Any]] = []

    # Collect public names (not starting with '_').
    # Use __all__ if defined, otherwise all non-private names.
    if hasattr(mod, "__all__"):
        export_names: list[str] = list(mod.__all__)
    else:
        export_names = [
            name for name in dir(mod)
            if not name.startswith("_")
        ]

    # For index files (stem == 'index' or 'main'), drop the file segment from path (SPEC §5).
    include_file_seg = file_stem.lower() not in ("index", "main")

    for name in export_names:
        try:
            value = getattr(mod, name)
        except AttributeError:
            continue

        # Build the §4 path.
        if include_file_seg:
            path_segs = [_seg(norm_file), _seg(name)]
        else:
            path_segs = [_seg(name)]

        op_id = _derive_id(ns_raw, path_segs)

        if callable(value) and not isinstance(value, type):
            # --- action (callable export) ---
            try:
                sig = inspect.signature(value)
            except (ValueError, TypeError):
                sig = inspect.Signature()

            streaming = _is_streaming(value)
            is_async = _is_async(value)
            input_schema = _params_to_input_schema(sig)
            output_schema = _return_to_output_schema(sig)

            op: dict[str, Any] = {
                "id": op_id,
                "host": "python",
                "namespace": namespace_seg,
                "path": path_segs,
                "kind": "action",
                "async": is_async,
                "streaming": streaming,
                "safe": False,
                "input": input_schema,
                "output": output_schema,
                "envelope": {},
                "typeText": None,
            }
            operations.append(op)

        elif isinstance(value, type):
            # Class export → constructor + public instance methods (SPEC §10).
            # Constructor.
            try:
                sig = inspect.signature(value.__init__)
            except (ValueError, TypeError):
                sig = inspect.Signature()

            input_schema = _params_to_input_schema(sig)
            ctor_path = path_segs + [] if include_file_seg else path_segs
            ctor_op: dict[str, Any] = {
                "id": op_id,
                "host": "python",
                "namespace": namespace_seg,
                "path": path_segs,
                "kind": "constructor",
                "async": False,
                "streaming": False,
                "safe": False,
                "input": input_schema,
                "output": {"type": "object", "properties": {"instanceId": {"type": "string"}}},
                "envelope": {},
                "typeText": None,
            }
            operations.append(ctor_op)

        elif not callable(value):
            # Serialisable const → query.
            if _is_serialisable(value):
                # Infer schema from value type.
                val_type = type(value)
                type_map = {str: "string", int: "integer", float: "number", bool: "boolean",
                            list: "array", dict: "object"}
                json_type = type_map.get(val_type, "object")
                output_schema = {"type": json_type}

                query_op: dict[str, Any] = {
                    "id": op_id,
                    "host": "python",
                    "namespace": namespace_seg,
                    "path": path_segs,
                    "kind": "query",
                    "async": False,
                    "streaming": False,
                    "safe": True,
                    "input": {"type": "object", "properties": {}},
                    "output": output_schema,
                    "envelope": {},
                    "typeText": None,
                }
                operations.append(query_op)
            else:
                warnings.warn(
                    f"apigen-python extractor: skipping non-serialisable, non-callable export '{name}'",
                    stacklevel=2,
                )

    return operations


# ---------------------------------------------------------------------------
# CLI entry point (subprocess protocol: JSON on stdout)
# ---------------------------------------------------------------------------

def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Extract apigen Operation descriptors from a Python source file."
    )
    parser.add_argument("source", help="Path to the Python source file")
    parser.add_argument(
        "--namespace", "-n", default=None,
        help="Namespace slug (default: normalised file stem)"
    )
    args = parser.parse_args()

    try:
        ops = extract_module(args.source, namespace=args.namespace)
        print(json.dumps(ops, indent=2))
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _main()
