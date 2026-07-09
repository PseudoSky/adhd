"""Thin runtime client for adhd-environment snapshots (Python port).

Reads a pre-built snapshot JSON file and exposes typed accessors for
config, paths, env vars, and provenance -- an API surface identical to
the TypeScript (``@adhd/environment``) and Rust runtime clients. No
builder logic, no YAML parsing, no ``.env`` loading, no disk writes.

This module also carries the four cross-language pure primitives
(``content_hash``, ``project_env_prefix``, ``infer_env_var``,
``generate_field_schema``) described in
``docs/plan/adhd-environment/interfaces-architect.md`` section 2.4. In
TypeScript these live in the separate ``@adhd/environment-base-spec``
package; this Python port has no base-spec counterpart, so they are
implemented here and re-exported from :mod:`adhd_environment`. They
MUST reproduce, byte-for-byte / string-for-string, every vector in
``packages/environment/environment-base-spec/spec/cross-language-test-vectors.json``.

See ``docs/plan/adhd-environment/interfaces-architect.md`` sections 2 and 4.2
for the exact API spec this module conforms to.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Literal, Optional, Union

Scope = Literal["system", "global", "project"]

#: Defaults mirrored from ``environment-base-spec/src/constants.ts``.
DEFAULT_ORG_NAMESPACE = "adhd"
DEFAULT_NAMESPACE = "default"
SNAPSHOT_FILENAME = "adhd-environment.json"

#: contentHash serialization format version (mirrors
#: ``CONTENT_HASH_FORMAT_VERSION`` in ``environment-base-spec/src/index.ts``).
#: v2 == the length-prefixed, injective encoding (see :func:`content_hash`).
CONTENT_HASH_FORMAT_VERSION = 2

#: Reserved prefix marking a redacted secret reference (mirrors
#: ``SECRET_REF_PREFIX`` in ``environment-base-spec``). A resolved config
#: value of ``"adhd-secret-ref:ADHD_FOO_SECRET"`` means "read the secret from
#: env var ``ADHD_FOO_SECRET`` at runtime"; the plaintext is never persisted.
SECRET_REF_PREFIX = "adhd-secret-ref:"

#: The genuine JSON-Schema keywords a field definition may contribute to a
#: generated schema. adhd-specific metadata (``env``/``scope``/``secret``/
#: ``noEnv``) is intentionally excluded (see :func:`generate_field_schema`).
_JSON_SCHEMA_LEAF_KEYS = (
    "type",
    "default",
    "description",
    "minimum",
    "maximum",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "items",
)


class EnvironmentError(Exception):
    """Base exception for all ``adhd_environment`` runtime errors."""


class LoneSurrogateError(EnvironmentError):
    """Raised by :func:`content_hash` when a key or value contains a lone
    (unpaired) UTF-16 surrogate code point (U+D800--U+DFFF).

    Such strings are not well-formed Unicode and have no canonical UTF-8
    encoding. Rather than raising Python's low-level ``UnicodeEncodeError``
    (the old behaviour, which diverged from TypeScript's silent U+FFFD
    substitution), all ports reject them with this one, specified error
    (ENV-CORE-005).
    """

    def __init__(self, location: str) -> None:
        self.location = location
        super().__init__(
            f"contentHash: lone surrogate in {location} (not well-formed Unicode)"
        )


def _has_lone_surrogate(s: str) -> bool:
    """True if ``s`` contains an unpaired UTF-16 surrogate code point."""
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def _validate_path_segment(segment: str, label: str) -> None:
    """Reject a ``project``/``namespace`` value that could escape ``adhd_root``
    when interpolated into a filesystem path (ENV-CORE-006).

    Rejects empty strings, ``.``/``..``, path separators (``/`` or ``\\``),
    embedded NUL, and absolute paths.
    """
    if not segment:
        raise ValueError(f"{label} must be a non-empty path segment")
    if segment in (".", ".."):
        raise ValueError(f"{label} must not be '.' or '..': {segment!r}")
    if "/" in segment or "\\" in segment or "\x00" in segment:
        raise ValueError(
            f"{label} must not contain path separators or NUL: {segment!r}"
        )
    if os.path.isabs(segment):
        raise ValueError(f"{label} must not be an absolute path: {segment!r}")


class SnapshotNotFoundError(EnvironmentError):
    """Raised when the snapshot JSON file does not exist on disk.

    Mirrors the TypeScript runtime client's constructor throwing when the
    snapshot file is missing (interfaces-architect.md section 4.2:
    "@throws If the snapshot file does not exist.").
    """

    def __init__(self, path: Union[str, "Path"]) -> None:
        self.path = Path(path)
        super().__init__(f"adhd-environment snapshot not found: {self.path}")


# ---------------------------------------------------------------------------
# Cross-language primitives (interfaces-architect.md section 2.4)
# ---------------------------------------------------------------------------


def content_hash(config: dict[str, str]) -> str:
    """Return the ``sha256-``-prefixed content hash of a flat config map.

    Uses the length-prefixed, **injective** serialization (format v2, see
    ``environment-base-spec`` SPEC.md section 4.1):

      1. Reject any key or value containing a lone surrogate
         (:class:`LoneSurrogateError`, ENV-CORE-005).
      2. Sort keys ascending by Unicode code point (Python ``sorted`` already
         orders by code point, matching Rust and the corrected TS port --
         ENV-CORE-002).
      3. For each key ``k``, emit ``f"{len_utf8(k)}:{k}={len_utf8(v)}:{v}\\n"``
         where the length prefixes are UTF-8 byte counts.
      4. SHA-256 the UTF-8 bytes; return ``"sha256-" + hexdigest``.

    The byte-length prefixes make the encoding injective: ``=`` or ``\\n``
    inside a key/value can never be mistaken for a delimiter (ENV-CORE-004).

    Args:
        config: Flat mapping of string keys to string values. Order is
            irrelevant -- the function sorts before hashing.

    Returns:
        The ``sha256-``-prefixed lowercase hex digest.
    """
    parts: list[str] = []
    for key in sorted(config):
        value = config[key]
        if _has_lone_surrogate(key):
            raise LoneSurrogateError("key")
        if _has_lone_surrogate(value):
            raise LoneSurrogateError("value")
        key_len = len(key.encode("utf-8"))
        value_len = len(value.encode("utf-8"))
        parts.append(f"{key_len}:{key}={value_len}:{value}\n")
    serialized = "".join(parts)
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return f"sha256-{digest}"


def project_env_prefix(project_name: str) -> str:
    """Infer the ``ADHD_``-prefixed env var prefix from a project name.

    Algorithm: uppercase the project name, fold both ``-`` **and** ``.`` to
    ``_`` (so a dotted project name yields a legal POSIX env-var prefix --
    ENV-CORE-003), prepend ``"ADHD_"``.

    Examples:
        ``project_env_prefix("agent-mcp")`` -> ``"ADHD_AGENT_MCP"``
        ``project_env_prefix("decompile-cli")`` -> ``"ADHD_DECOMPILE_CLI"``
        ``project_env_prefix("foo.bar")`` -> ``"ADHD_FOO_BAR"``
    """
    return "ADHD_" + re.sub(r"[.-]", "_", project_name.upper())


def infer_env_var(prefix: str, field_path: str) -> str:
    """Infer the env var name for a dot-separated config field path.

    Algorithm: uppercase ``field_path``, fold both ``.`` and ``-`` to
    ``_`` (per ``_shared.md`` def:inferEnvVar -- the dashed-and-dotted
    cross-language vector exercises both separators), prepend
    ``prefix + "_"``.

    Examples:
        ``infer_env_var("ADHD_AGENT_MCP", "db.path")``
        -> ``"ADHD_AGENT_MCP_DB_PATH"``
        ``infer_env_var("ADHD_AGENT_MCP", "provider-key.secret")``
        -> ``"ADHD_AGENT_MCP_PROVIDER_KEY_SECRET"``
    """
    folded = re.sub(r"[.-]", "_", field_path.upper())
    return f"{prefix}_{folded}"


def generate_field_schema(fields: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Convert flat dot-path field definitions into a nested JSON Schema.

    ``{"server.port": {"type": "integer", "minimum": 1024}}`` becomes::

        {
            "type": "object",
            "properties": {
                "server": {
                    "type": "object",
                    "properties": {
                        "port": {"type": "integer", "minimum": 1024},
                    },
                },
            },
        }

    Parent nodes sharing a common path prefix (e.g. ``db.path`` and
    ``db.pool.size``) are reused rather than duplicated. Key insertion
    order is not semantically significant -- compare results structurally
    (plain dict equality), not by serialized string, since other language
    implementations may legitimately emit keys in a different order.

    Each leaf keeps ONLY genuine JSON-Schema keywords (``type``, ``default``,
    ``description``, ``minimum``, ``maximum``, ``enum``, ``pattern``,
    ``minLength``, ``maxLength``, ``items``). adhd-specific metadata
    (``env``, ``scope``, ``secret``, ``noEnv``) is dropped -- copying it
    verbatim leaked which fields are secrets and their env-var names
    (ENV-CORE-001).

    Args:
        fields: Flat mapping of dot-separated field path to a JSON
            Schema leaf field definition.

    Returns:
        A nested JSON Schema object rooted at ``{"type": "object", ...}``.
    """
    root: dict[str, Any] = {"type": "object", "properties": {}}
    for field_path, field_def in fields.items():
        parts = field_path.split(".")
        node = root
        last_index = len(parts) - 1
        for index, part in enumerate(parts):
            properties = node["properties"]
            if index == last_index:
                properties[part] = _field_definition_to_json_schema(field_def)
            else:
                if part not in properties:
                    properties[part] = {"type": "object", "properties": {}}
                node = properties[part]
    return root


def _field_definition_to_json_schema(field_def: dict[str, Any]) -> dict[str, Any]:
    """Project a field definition onto its genuine JSON-Schema keywords only,
    dropping adhd-specific metadata (``env``/``scope``/``secret``/``noEnv``).
    Mirrors ``fieldDefinitionToJsonSchema`` in ``environment-base-spec``.
    """
    return {key: field_def[key] for key in _JSON_SCHEMA_LEAF_KEYS if key in field_def}


# ---------------------------------------------------------------------------
# Environment runtime client (interfaces-architect.md section 4.2)
# ---------------------------------------------------------------------------


class Environment:
    """Thin runtime client. Reads a pre-built snapshot JSON file and exposes
    typed accessors. Does NOT do: YAML parsing, env var resolution, field
    merge, fieldSchema generation, validation, or directory creation.

    Usage::

        env = Environment("agent-mcp", namespace="production")
        port = env.get("config.transport.port")

    Attributes:
        project: Project name (kebab-case), as supplied to the constructor.
        namespace: Effective namespace (defaults to ``"default"``).
        org_namespace: Effective org namespace, read from the snapshot's
            ``project.orgNamespace`` (defaults to ``"adhd"`` if absent).
        scope: Optional scope filter (``"system" | "global" | "project"``).
            When set, ``get("config.*")`` returns ``None`` for fields whose
            provenance scope does not match.
        snapshot_path: Absolute path to the snapshot JSON file that was read.
        prefix: Effective env var prefix, read from the snapshot's
            ``project.envPrefix``.
        hash: Content hash from the snapshot (``configHash``).
    """

    def __init__(
        self,
        project: str,
        *,
        scope: Optional[Scope] = None,
        namespace: Optional[str] = None,
        adhd_root: Optional[Union[str, Path]] = None,
    ) -> None:
        """Construct a runtime client bound to a single project snapshot.

        Args:
            project: Required. Project name (kebab-case).
            scope: Optional. Filters returned config values by scope.
            namespace: Optional. Defaults to ``"default"``.
            adhd_root: Optional. Root directory containing org data.
                Defaults to ``Path.home() / ".adhd"``.

        Raises:
            ValueError: If ``project`` is empty.
            SnapshotNotFoundError: If the snapshot file does not exist.
        """
        if not project:
            raise ValueError("Environment requires a non-empty 'project' name")

        self.project: str = project
        self.namespace: str = namespace or DEFAULT_NAMESPACE
        self.scope: Optional[Scope] = scope

        # ENV-CORE-006: guard against path traversal before interpolating
        # project/namespace into the snapshot path.
        _validate_path_segment(self.project, "project")
        _validate_path_segment(self.namespace, "namespace")

        root = (
            Path(adhd_root)
            if adhd_root is not None
            else Path.home() / f".{DEFAULT_ORG_NAMESPACE}"
        )
        self.snapshot_path: Path = root / self.project / self.namespace / SNAPSHOT_FILENAME

        if not self.snapshot_path.is_file():
            raise SnapshotNotFoundError(self.snapshot_path)

        with self.snapshot_path.open("r", encoding="utf-8") as handle:
            self._data: dict[str, Any] = json.load(handle)

        project_meta: dict[str, Any] = self._data.get("project") or {}
        self.org_namespace: str = project_meta.get("orgNamespace", DEFAULT_ORG_NAMESPACE)
        self.prefix: str = project_meta.get("envPrefix") or project_env_prefix(self.project)
        self.hash: str = self._data.get("configHash", "")

    def get(self, key: str) -> Any:
        """Typed config/dir/provenance/env accessor.

        Path prefixes:
            ``config.*``     -> reads from the snapshot's ``config`` (nested,
                                 dot-separated path)
            ``path.*``       -> reads from the snapshot's ``dirs`` (by
                                 directory type, or ``type.name``)
            ``env.*``        -> reads from the snapshot's ``envVars``
            ``provenance.*`` -> reads from the snapshot's ``provenance``

        Scope filtering: when ``self.scope`` is set, config values whose
        provenance scope does not match ``self.scope`` return ``None``.

        Args:
            key: A dotted path beginning with one of the four prefixes
                above, e.g. ``"config.transport.port"``.

        Returns:
            The resolved value, or ``None`` if not found / filtered out
            by scope.
        """
        namespace_key, separator, rest = key.partition(".")
        if not separator:
            return None

        if namespace_key == "config":
            return self._get_config_value(rest)
        if namespace_key == "path":
            return self._get_path_value(rest)
        if namespace_key == "env":
            return self._data.get("envVars", {}).get(rest)
        if namespace_key == "provenance":
            return self._data.get("provenance", {}).get(rest)
        return None

    def __getitem__(self, key: str) -> Any:
        """Bracket access shorthand. ``env["config.x"] == env.get("config.x")``."""
        return self.get(key)

    def to_json(self) -> dict[str, Any]:
        """Return a deep copy of the full snapshot. Used for debugging."""
        return json.loads(json.dumps(self._data))

    # -- internal helpers ----------------------------------------------------

    def _get_config_value(self, dotted_path: str) -> Any:
        """Resolve ``dotted_path`` against the nested ``config`` tree,
        then apply scope filtering via the matching provenance entry.
        """
        node: Any = self._data.get("config", {})
        for part in dotted_path.split("."):
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return None

        if self.scope is not None:
            provenance = self._data.get("provenance", {}).get(dotted_path)
            if provenance is None or provenance.get("scope") != self.scope:
                return None

        # ENV-CORE-009: secret fields persist a reference, not the plaintext.
        # Resolve the live value from the environment at read time (or None
        # when the env var is unset).
        if isinstance(node, str) and node.startswith(SECRET_REF_PREFIX):
            env_var = node[len(SECRET_REF_PREFIX):]
            return os.environ.get(env_var)

        return node

    def _get_path_value(self, rest: str) -> Optional[str]:
        """Resolve a ``path.*`` lookup against ``dirs`` entries.

        Directory types themselves contain a literal dot (e.g.
        ``"state.data"``), so a bare type-only lookup
        (``path.state.data``) is disambiguated from a type+name lookup
        (``path.state.data.registry``) by first trying an exact
        ``"{type}.{name}"`` match, then falling back to a bare ``type``
        match.
        """
        dirs = self._data.get("dirs", [])

        for entry in dirs:
            if self.scope is not None and entry.get("scope") != self.scope:
                continue
            name = entry.get("name")
            if name and f"{entry.get('type', '')}.{name}" == rest:
                return entry.get("path")

        for entry in dirs:
            if self.scope is not None and entry.get("scope") != self.scope:
                continue
            if entry.get("type") == rest:
                return entry.get("path")

        return None
