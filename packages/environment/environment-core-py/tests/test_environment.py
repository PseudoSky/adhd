"""Tests for adhd_environment.environment.Environment -- the thin runtime
client. Verifies it reads a pre-built snapshot JSON and exposes typed
config/path/env/provenance accessors, per
docs/plan/adhd-environment/interfaces-architect.md section 4.2.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adhd_environment import (
    DEFAULT_NAMESPACE,
    SNAPSHOT_FILENAME,
    Environment,
    EnvironmentError,
    SnapshotNotFoundError,
)

SAMPLE_SNAPSHOT = {
    "version": "1.0.0",
    "libraryVersion": "0.0.5",
    "generatedAt": "2026-01-01T00:00:00.000Z",
    "project": {
        "name": "agent-mcp",
        "orgNamespace": "adhd",
        "envPrefix": "ADHD_AGENT_MCP",
        "namespace": "production",
    },
    "config": {
        "transport": {"port": 8080},
        "db": {"path": "./data.sqlite"},
    },
    "raw": {"transport.port": 8080, "db.path": "./data.sqlite"},
    "fieldSchema": None,
    "configHash": "sha256-deadbeef",
    "structureHash": "sha256-cafef00d",
    "dirs": [
        {
            "type": "state.data",
            "path": "/tmp/adhd/agent-mcp/production/state",
            "scope": "project",
        },
        {
            "type": "state.data",
            "name": "registry",
            "path": "/tmp/adhd/agent-mcp/production/state/registry",
            "scope": "project",
        },
        {
            "type": "runtime.log",
            "path": "/tmp/adhd/agent-mcp/production/logs",
            "scope": "global",
        },
    ],
    "provenance": {
        "transport.port": {
            "source": "project.default",
            "scope": "project",
        },
        "db.path": {
            "source": "global.default",
            "scope": "global",
        },
    },
    "envVars": {"ADHD_AGENT_MCP_TRANSPORT_PORT": "8080"},
}


def _write_snapshot(adhd_root: Path, project: str, namespace: str, data: dict) -> Path:
    snapshot_dir = adhd_root / project / namespace
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = snapshot_dir / SNAPSHOT_FILENAME
    snapshot_path.write_text(json.dumps(data), encoding="utf-8")
    return snapshot_path


@pytest.fixture()
def env(tmp_path: Path) -> Environment:
    _write_snapshot(tmp_path, "agent-mcp", "production", SAMPLE_SNAPSHOT)
    return Environment("agent-mcp", namespace="production", adhd_root=tmp_path)


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_environment_imports_without_error() -> None:
    """[runtime-py.3] Importing Environment must not raise."""
    from adhd_environment.environment import Environment as ImportedEnvironment

    assert ImportedEnvironment is Environment


def test_environment_raises_snapshot_not_found_when_missing(tmp_path: Path) -> None:
    with pytest.raises(SnapshotNotFoundError):
        Environment("nonexistent-project", adhd_root=tmp_path)


def test_snapshot_not_found_error_is_environment_error(tmp_path: Path) -> None:
    assert issubclass(SnapshotNotFoundError, EnvironmentError)
    assert issubclass(EnvironmentError, Exception)
    with pytest.raises(EnvironmentError):
        Environment("nonexistent-project", adhd_root=tmp_path)


def test_environment_requires_nonempty_project(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        Environment("", adhd_root=tmp_path)


def test_environment_defaults_namespace_to_default(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "agent-mcp", DEFAULT_NAMESPACE, SAMPLE_SNAPSHOT)
    result = Environment("agent-mcp", adhd_root=tmp_path)
    assert result.namespace == DEFAULT_NAMESPACE


def test_environment_defaults_adhd_root_to_home_dot_adhd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    _write_snapshot(fake_home / ".adhd", "agent-mcp", DEFAULT_NAMESPACE, SAMPLE_SNAPSHOT)
    result = Environment("agent-mcp")
    assert result.snapshot_path == fake_home / ".adhd" / "agent-mcp" / DEFAULT_NAMESPACE / SNAPSHOT_FILENAME


# ---------------------------------------------------------------------------
# Metadata surface
# ---------------------------------------------------------------------------


def test_environment_exposes_metadata(env: Environment) -> None:
    assert env.project == "agent-mcp"
    assert env.namespace == "production"
    assert env.org_namespace == "adhd"
    assert env.prefix == "ADHD_AGENT_MCP"
    assert env.hash == "sha256-deadbeef"


def test_environment_prefix_falls_back_to_inferred_when_snapshot_omits_it(tmp_path: Path) -> None:
    data = json.loads(json.dumps(SAMPLE_SNAPSHOT))
    del data["project"]["envPrefix"]
    _write_snapshot(tmp_path, "agent-mcp", "production", data)
    result = Environment("agent-mcp", namespace="production", adhd_root=tmp_path)
    assert result.prefix == "ADHD_AGENT_MCP"


# ---------------------------------------------------------------------------
# get() -- config.*
# ---------------------------------------------------------------------------


def test_get_config_dotted_path(env: Environment) -> None:
    assert env.get("config.transport.port") == 8080
    assert env.get("config.db.path") == "./data.sqlite"


def test_get_config_missing_path_returns_none(env: Environment) -> None:
    assert env.get("config.does.not.exist") is None


def test_get_unknown_prefix_returns_none(env: Environment) -> None:
    assert env.get("unknown.thing") is None


def test_get_key_without_dot_returns_none(env: Environment) -> None:
    assert env.get("config") is None


# ---------------------------------------------------------------------------
# get() -- path.*
# ---------------------------------------------------------------------------


def test_get_path_by_type_only(env: Environment) -> None:
    assert env.get("path.state.data") == "/tmp/adhd/agent-mcp/production/state"


def test_get_path_by_type_and_name(env: Environment) -> None:
    assert env.get("path.state.data.registry") == "/tmp/adhd/agent-mcp/production/state/registry"


def test_get_path_runtime_log(env: Environment) -> None:
    assert env.get("path.runtime.log") == "/tmp/adhd/agent-mcp/production/logs"


def test_get_path_unknown_returns_none(env: Environment) -> None:
    assert env.get("path.runtime.cache") is None


# ---------------------------------------------------------------------------
# get() -- env.*
# ---------------------------------------------------------------------------


def test_get_env_var(env: Environment) -> None:
    assert env.get("env.ADHD_AGENT_MCP_TRANSPORT_PORT") == "8080"


def test_get_env_var_missing_returns_none(env: Environment) -> None:
    assert env.get("env.NOT_SET") is None


# ---------------------------------------------------------------------------
# get() -- provenance.*
# ---------------------------------------------------------------------------


def test_get_provenance(env: Environment) -> None:
    assert env.get("provenance.transport.port") == {
        "source": "project.default",
        "scope": "project",
    }


def test_get_provenance_missing_returns_none(env: Environment) -> None:
    assert env.get("provenance.does.not.exist") is None


# ---------------------------------------------------------------------------
# Bracket access
# ---------------------------------------------------------------------------


def test_bracket_access_matches_get(env: Environment) -> None:
    assert env["config.transport.port"] == env.get("config.transport.port")
    assert env["env.ADHD_AGENT_MCP_TRANSPORT_PORT"] == env.get("env.ADHD_AGENT_MCP_TRANSPORT_PORT")


# ---------------------------------------------------------------------------
# Scope filtering
# ---------------------------------------------------------------------------


def test_scope_filtering_returns_matching_value(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "agent-mcp", "production", SAMPLE_SNAPSHOT)
    scoped = Environment("agent-mcp", namespace="production", scope="project", adhd_root=tmp_path)
    assert scoped.get("config.transport.port") == 8080  # provenance scope == "project"


def test_scope_filtering_excludes_non_matching_value(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "agent-mcp", "production", SAMPLE_SNAPSHOT)
    scoped = Environment("agent-mcp", namespace="production", scope="project", adhd_root=tmp_path)
    assert scoped.get("config.db.path") is None  # provenance scope == "global", filtered out


def test_scope_filtering_applies_to_dirs(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "agent-mcp", "production", SAMPLE_SNAPSHOT)
    scoped = Environment("agent-mcp", namespace="production", scope="global", adhd_root=tmp_path)
    assert scoped.get("path.state.data") is None  # dirs entry scope == "project"
    assert scoped.get("path.runtime.log") == "/tmp/adhd/agent-mcp/production/logs"


# ---------------------------------------------------------------------------
# to_json()
# ---------------------------------------------------------------------------


def test_to_json_returns_equal_but_independent_copy(env: Environment) -> None:
    snapshot_copy = env.to_json()
    assert snapshot_copy == SAMPLE_SNAPSHOT

    snapshot_copy["config"]["transport"]["port"] = 9999
    assert env.get("config.transport.port") == 8080  # original untouched by mutation


# ---------------------------------------------------------------------------
# ENV-CORE-006 -- path traversal guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_project", ["..", "../../../etc", "a/b", "a\\b", "/abs"])
def test_environment_rejects_traversal_in_project(tmp_path: Path, bad_project: str) -> None:
    with pytest.raises(ValueError):
        Environment(bad_project, adhd_root=tmp_path)


@pytest.mark.parametrize("bad_namespace", ["..", "../../../etc", "a/b", "a\\b", "/abs"])
def test_environment_rejects_traversal_in_namespace(tmp_path: Path, bad_namespace: str) -> None:
    with pytest.raises(ValueError):
        Environment("agent-mcp", namespace=bad_namespace, adhd_root=tmp_path)


def test_traversal_guard_blocks_escape_before_read(tmp_path: Path) -> None:
    """A crafted project must not resolve a snapshot path that escapes
    adhd_root -- the guard raises before any filesystem access."""
    # Plant a snapshot OUTSIDE the adhd_root that a naive join would reach.
    outside = tmp_path / "outside"
    _write_snapshot(outside, "default", "default", SAMPLE_SNAPSHOT)
    with pytest.raises(ValueError):
        Environment("../outside", namespace="default", adhd_root=tmp_path / "root")


# ---------------------------------------------------------------------------
# ENV-CORE-009 -- secret references resolve from the environment at read time
# ---------------------------------------------------------------------------


def _secret_snapshot() -> dict:
    data = json.loads(json.dumps(SAMPLE_SNAPSHOT))
    # A secret field persists a REFERENCE, never the plaintext value.
    data["config"]["providers"] = {"openai": {"secret": "adhd-secret-ref:OPENAI_API_KEY"}}
    data["raw"]["providers.openai.secret"] = "adhd-secret-ref:OPENAI_API_KEY"
    data["provenance"]["providers.openai.secret"] = {
        "source": "project.override",
        "scope": "project",
        "env": "OPENAI_API_KEY",
    }
    return data


def test_secret_reference_resolves_from_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(tmp_path, "agent-mcp", "production", _secret_snapshot())
    monkeypatch.setenv("OPENAI_API_KEY", "sk-live-secret")
    env = Environment("agent-mcp", namespace="production", adhd_root=tmp_path)
    assert env.get("config.providers.openai.secret") == "sk-live-secret"


def test_secret_reference_returns_none_when_env_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(tmp_path, "agent-mcp", "production", _secret_snapshot())
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    env = Environment("agent-mcp", namespace="production", adhd_root=tmp_path)
    assert env.get("config.providers.openai.secret") is None


def test_secret_plaintext_never_on_disk(tmp_path: Path) -> None:
    """The snapshot bytes must contain only the reference, never the value."""
    path = _write_snapshot(tmp_path, "agent-mcp", "production", _secret_snapshot())
    on_disk = path.read_bytes()
    assert b"adhd-secret-ref:OPENAI_API_KEY" in on_disk
    assert b"sk-live-secret" not in on_disk
