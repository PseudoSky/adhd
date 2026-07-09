"""adhd_environment -- Python runtime client for @adhd/environment snapshots.

Thin runtime client (~40 lines of public surface): reads a pre-built
snapshot JSON file and exposes typed accessors for config, paths, env
vars, and provenance. Identical API surface to the TypeScript
(``@adhd/environment``) and Rust runtime clients. No builder logic, no
``.env`` loading, no disk writes.

See ``docs/plan/adhd-environment/interfaces-architect.md`` sections 2
and 4.2 for the full API spec.
"""

from .environment import (
    DEFAULT_NAMESPACE,
    DEFAULT_ORG_NAMESPACE,
    SNAPSHOT_FILENAME,
    Environment,
    EnvironmentError,
    Scope,
    SnapshotNotFoundError,
    content_hash,
    generate_field_schema,
    infer_env_var,
    project_env_prefix,
)

__all__ = [
    "DEFAULT_NAMESPACE",
    "DEFAULT_ORG_NAMESPACE",
    "SNAPSHOT_FILENAME",
    "Environment",
    "EnvironmentError",
    "Scope",
    "SnapshotNotFoundError",
    "content_hash",
    "generate_field_schema",
    "infer_env_var",
    "project_env_prefix",
]

__version__ = "0.0.1"
