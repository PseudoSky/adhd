//! `adhd-environment` — Rust runtime client for `@adhd/environment`.
//!
//! This crate is a **thin runtime client**: it reads a pre-built
//! `adhd-environment.json` snapshot from disk and exposes typed accessors
//! for config values, resolved directory paths, recorded env vars, and
//! field provenance. It performs **no** builder logic: no YAML parsing, no
//! env var resolution, no field merging, no fieldSchema generation, no
//! validation, no directory creation, and no `.env` file loading. The
//! snapshot is produced by the (TypeScript) builder pipeline; this crate
//! only ever reads it.
//!
//! It also re-implements the handful of pure, cross-language primitives
//! defined by `@adhd/environment-base-spec` ([`content_hash`],
//! [`project_env_prefix`], [`infer_env_var`], [`generate_field_schema`]) so
//! that Rust callers get byte-identical output to the TypeScript and Python
//! implementations. The pinned vectors in
//! `environment-base-spec/spec/cross-language-test-vectors.json` are the
//! single source of truth for these functions and are asserted against in
//! this crate's test suite (`cargo test`).

use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Snapshot format version this crate was written against. Mirrors
/// `SPEC_VERSION` in `environment-base-spec/src/constants.ts`.
pub const SPEC_VERSION: &str = "0.0.5";

/// Default org namespace, used to derive the default `adhdRoot`
/// (`$HOME/.adhd`) when no override is supplied.
pub const DEFAULT_ORG_NAMESPACE: &str = "adhd";

/// Default namespace segment when none is supplied.
pub const DEFAULT_NAMESPACE: &str = "default";

/// Filename of the snapshot written by the builder and read by every
/// runtime client.
pub const SNAPSHOT_FILENAME: &str = "adhd-environment.json";

// ============================================================================
// Cross-cutting scope + directory-type enums
// ============================================================================

/// Three-tier field resolution scope: `system` -> `global` -> `project`,
/// with `project` overriding `global` overriding `system`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    System,
    Global,
    Project,
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Scope::System => "system",
            Scope::Global => "global",
            Scope::Project => "project",
        })
    }
}

/// Error returned when parsing a [`Scope`] from a free-form string fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseScopeError(pub String);

impl fmt::Display for ParseScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid scope {:?}: expected \"system\", \"global\", or \"project\"",
            self.0
        )
    }
}

impl std::error::Error for ParseScopeError {}

impl std::str::FromStr for Scope {
    type Err = ParseScopeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "system" => Ok(Scope::System),
            "global" => Ok(Scope::Global),
            "project" => Ok(Scope::Project),
            other => Err(ParseScopeError(other.to_string())),
        }
    }
}

/// The four directory categories a project may declare in its directory
/// catalog. Note that the wire-format string values are themselves
/// dot-separated (e.g. `"state.data"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DirectoryType {
    #[serde(rename = "state.data")]
    StateData,
    #[serde(rename = "runtime.log")]
    RuntimeLog,
    #[serde(rename = "runtime.cache")]
    RuntimeCache,
    #[serde(rename = "runtime.temp")]
    RuntimeTemp,
}

impl DirectoryType {
    /// The four known directory-type wire values, in declaration order.
    pub const ALL: [DirectoryType; 4] = [
        DirectoryType::StateData,
        DirectoryType::RuntimeLog,
        DirectoryType::RuntimeCache,
        DirectoryType::RuntimeTemp,
    ];

    /// The exact wire-format string for this directory type (matches the
    /// JSON Schema `directoryType` enum in `adhd-environment.schema.json`).
    pub fn as_str(&self) -> &'static str {
        match self {
            DirectoryType::StateData => "state.data",
            DirectoryType::RuntimeLog => "runtime.log",
            DirectoryType::RuntimeCache => "runtime.cache",
            DirectoryType::RuntimeTemp => "runtime.temp",
        }
    }
}

impl fmt::Display for DirectoryType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ============================================================================
// Snapshot data model — mirrors adhd-environment.schema.json exactly
// ============================================================================

/// Resolved identity of the project + namespace pairing a snapshot was
/// built for. Mirrors `$defs.projectIdentity` in
/// `adhd-environment.schema.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectIdentity {
    pub name: String,
    #[serde(rename = "orgNamespace")]
    pub org_namespace: String,
    #[serde(rename = "envPrefix")]
    pub env_prefix: String,
    pub namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Provenance of a single resolved config field. Mirrors
/// `$defs.provenanceEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProvenanceEntry {
    /// One of `project.env`, `project.set`, `project.default`,
    /// `project.override`, `global.env`, `global.default`,
    /// `system.default` (see `$defs.provenanceSource`).
    pub source: String,
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
}

/// A [`DirectoryEntry`](self) after path resolution, as written into the
/// snapshot's `dirs` array. Mirrors `$defs.resolvedDirectoryEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedDirectoryEntry {
    #[serde(rename = "type")]
    pub dir_type: DirectoryType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Fully expanded, absolute path.
    pub path: String,
    pub scope: Scope,
}

/// The full on-disk snapshot shape written by the builder and read by
/// every runtime client. Mirrors the top-level `properties` of
/// `adhd-environment.schema.json` / the TypeScript `SnapshotData`
/// interface field-for-field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotData {
    /// Snapshot format version (semver). Should equal [`SPEC_VERSION`] at
    /// build time.
    pub version: String,
    #[serde(rename = "libraryVersion")]
    pub library_version: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub project: ProjectIdentity,
    /// Fully resolved, nested config object (dot-paths expanded into
    /// nested objects).
    pub config: Value,
    /// Flat, un-nested config (`dot.path` -> value) used for hashing and
    /// direct lookup.
    pub raw: BTreeMap<String, String>,
    /// Generated JSON Schema for validating `config`. `None` when the
    /// project declares no config fields.
    #[serde(rename = "fieldSchema")]
    pub field_schema: Option<Value>,
    /// `contentHash()` of `raw`.
    #[serde(rename = "configHash")]
    pub config_hash: String,
    /// Hash of logical directory structure (not absolute paths).
    #[serde(rename = "structureHash")]
    pub structure_hash: String,
    pub dirs: Vec<ResolvedDirectoryEntry>,
    /// Provenance map: flat field path -> provenance entry.
    pub provenance: BTreeMap<String, ProvenanceEntry>,
    /// Env var values recorded at build time.
    #[serde(rename = "envVars")]
    pub env_vars: BTreeMap<String, String>,
}

// ============================================================================
// Environment constructor params
// ============================================================================

/// Constructor parameters for [`Environment::new`]. Mirrors the
/// TypeScript `EnvironmentParams` interface.
#[derive(Debug, Clone, Default)]
pub struct EnvironmentParams {
    /// Project name (kebab-case). Required.
    pub project: String,
    /// Optional scope filter. When set, `get()` calls for values whose
    /// provenance/scope does not match return `None`.
    pub scope: Option<Scope>,
    /// Optional namespace. Defaults to [`DEFAULT_NAMESPACE`].
    pub namespace: Option<String>,
    /// Root directory containing the resolved snapshot tree. Defaults to
    /// `$ADHD_HOME`, falling back to `$HOME/.adhd` (or `$USERPROFILE/.adhd`
    /// on Windows) when unset.
    pub adhd_root: Option<String>,
}

impl EnvironmentParams {
    /// Construct params for the given project, with every optional field
    /// left at its default.
    pub fn new(project: impl Into<String>) -> Self {
        Self {
            project: project.into(),
            scope: None,
            namespace: None,
            adhd_root: None,
        }
    }

    /// Builder-style setter for `namespace`.
    #[must_use]
    pub fn with_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = Some(namespace.into());
        self
    }

    /// Builder-style setter for `scope`.
    #[must_use]
    pub fn with_scope(mut self, scope: Scope) -> Self {
        self.scope = Some(scope);
        self
    }

    /// Builder-style setter for `adhd_root`.
    #[must_use]
    pub fn with_adhd_root(mut self, adhd_root: impl Into<String>) -> Self {
        self.adhd_root = Some(adhd_root.into());
        self
    }
}

// ============================================================================
// Errors
// ============================================================================

/// Error type for [`Environment::new`].
#[derive(Debug)]
pub enum EnvironmentError {
    /// The snapshot file did not exist at the resolved path.
    SnapshotNotFound(PathBuf),
    /// The snapshot file existed but could not be read.
    Io(std::io::Error),
    /// The snapshot file existed but could not be parsed as valid
    /// `SnapshotData` JSON.
    Parse(serde_json::Error),
}

impl fmt::Display for EnvironmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnvironmentError::SnapshotNotFound(path) => {
                write!(
                    f,
                    "adhd-environment snapshot not found at {}",
                    path.display()
                )
            }
            EnvironmentError::Io(err) => {
                write!(f, "failed to read adhd-environment snapshot: {err}")
            }
            EnvironmentError::Parse(err) => {
                write!(f, "failed to parse adhd-environment snapshot: {err}")
            }
        }
    }
}

impl std::error::Error for EnvironmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            EnvironmentError::SnapshotNotFound(_) => None,
            EnvironmentError::Io(err) => Some(err),
            EnvironmentError::Parse(err) => Some(err),
        }
    }
}

impl From<std::io::Error> for EnvironmentError {
    fn from(err: std::io::Error) -> Self {
        EnvironmentError::Io(err)
    }
}

impl From<serde_json::Error> for EnvironmentError {
    fn from(err: serde_json::Error) -> Self {
        EnvironmentError::Parse(err)
    }
}

// ============================================================================
// Environment — the runtime client
// ============================================================================

/// Thin runtime client. Reads a pre-built snapshot JSON file and exposes
/// typed accessors. Does **not** do: YAML parsing, env var resolution,
/// field merge, fieldSchema generation, validation, or directory
/// creation.
///
/// ```no_run
/// use adhd_environment::{Environment, EnvironmentParams};
///
/// let env = Environment::new(
///     EnvironmentParams::new("agent-mcp").with_namespace("production"),
/// )
/// .expect("snapshot must exist");
/// let port = env.get_int("config.transport.port");
/// ```
#[derive(Debug)]
pub struct Environment {
    data: SnapshotData,
    /// Project name (kebab-case).
    pub project: String,
    /// Effective namespace.
    pub namespace: String,
    /// Effective org namespace (from the snapshot's `project.orgNamespace`).
    pub org_namespace: String,
    /// Scope filter (`None` = no filter).
    pub scope: Option<Scope>,
    /// Path to the snapshot file that was read.
    pub snapshot_path: PathBuf,
    /// Env prefix (from the snapshot's `project.envPrefix`).
    pub prefix: String,
    /// Content hash from the snapshot (`snapshot.configHash`).
    pub hash: String,
    /// Snapshot format version (`snapshot.version`).
    pub version: String,
}

impl Environment {
    /// Construct a new `Environment`, reading and parsing the snapshot
    /// file resolved from `params`.
    ///
    /// Path resolution: `<adhdRoot>/<project>/<namespace>/adhd-environment.json`,
    /// where `adhdRoot` defaults to `$ADHD_HOME` (falling back to
    /// `$HOME/.adhd` / `$USERPROFILE/.adhd`) and `namespace` defaults to
    /// [`DEFAULT_NAMESPACE`].
    ///
    /// # Errors
    ///
    /// Returns [`EnvironmentError::SnapshotNotFound`] if no snapshot
    /// exists at the resolved path, [`EnvironmentError::Io`] if the file
    /// exists but cannot be read, and [`EnvironmentError::Parse`] if its
    /// contents are not valid `SnapshotData` JSON.
    pub fn new(params: EnvironmentParams) -> Result<Self, EnvironmentError> {
        let namespace = params
            .namespace
            .clone()
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_string());
        let adhd_root = params.adhd_root.clone().unwrap_or_else(default_adhd_root);

        let snapshot_path = resolve_snapshot_path(&adhd_root, &params.project, &namespace);
        Self::from_path(params, namespace, snapshot_path)
    }

    /// Like [`Environment::new`], but reads the snapshot from an explicit
    /// path rather than deriving one from `adhdRoot`/`project`/`namespace`.
    /// Primarily useful for tests and tooling that already know the exact
    /// snapshot location.
    ///
    /// # Errors
    ///
    /// Same as [`Environment::new`].
    pub fn from_snapshot_path(
        params: EnvironmentParams,
        snapshot_path: impl AsRef<Path>,
    ) -> Result<Self, EnvironmentError> {
        let namespace = params
            .namespace
            .clone()
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_string());
        Self::from_path(params, namespace, snapshot_path.as_ref().to_path_buf())
    }

    fn from_path(
        params: EnvironmentParams,
        namespace: String,
        snapshot_path: PathBuf,
    ) -> Result<Self, EnvironmentError> {
        if !snapshot_path.is_file() {
            return Err(EnvironmentError::SnapshotNotFound(snapshot_path));
        }
        let contents = fs::read_to_string(&snapshot_path)?;
        let data: SnapshotData = serde_json::from_str(&contents)?;

        let org_namespace = data.project.org_namespace.clone();
        let prefix = data.project.env_prefix.clone();
        let hash = data.config_hash.clone();
        let version = data.version.clone();

        Ok(Self {
            project: params.project,
            namespace,
            org_namespace,
            scope: params.scope,
            snapshot_path,
            prefix,
            hash,
            version,
            data,
        })
    }

    /// Typed config/dir/provenance/env accessor.
    ///
    /// Path prefixes:
    /// - `"config.*"` reads from the snapshot's nested `config`
    ///   (dot-separated path).
    /// - `"path.*"` reads from the snapshot's `dirs` (by directory type,
    ///   optionally followed by `.<name>` for disambiguation, e.g.
    ///   `"path.state.data"` or `"path.state.data.registry"`).
    /// - `"env.*"` reads from the snapshot's recorded `envVars`.
    /// - `"provenance.*"` reads from the snapshot's `provenance` map.
    ///
    /// Scope filtering: when `self.scope` is set, `"config.*"` and
    /// `"path.*"` lookups whose resolved provenance/directory scope does
    /// not match return `None`.
    ///
    /// Returns `None` for unknown prefixes, missing paths, or
    /// scope-filtered values.
    pub fn get(&self, key: &str) -> Option<Value> {
        let (head, rest) = key.split_once('.')?;
        match head {
            "config" => self.get_config(rest),
            "env" => self.data.env_vars.get(rest).cloned().map(Value::String),
            "provenance" => self
                .data
                .provenance
                .get(rest)
                .and_then(|entry| serde_json::to_value(entry).ok()),
            "path" => self.get_path(rest),
            _ => None,
        }
    }

    fn get_config(&self, path: &str) -> Option<Value> {
        if let Some(scope) = self.scope {
            if let Some(entry) = self.data.provenance.get(path) {
                if entry.scope != scope {
                    return None;
                }
            }
        }
        get_nested(&self.data.config, path)
    }

    fn get_path(&self, rest: &str) -> Option<Value> {
        let (dir_type, name) = parse_path_key(rest)?;
        self.data
            .dirs
            .iter()
            .filter(|dir| dir.dir_type == dir_type)
            .filter(|dir| match self.scope {
                Some(scope) => dir.scope == scope,
                None => true,
            })
            .find(|dir| match (&name, &dir.name) {
                (Some(wanted), Some(actual)) => wanted == actual,
                (None, None) => true,
                // A disambiguating name was requested but this entry has
                // none (or vice versa) -- not a match. "path.<type>" (no
                // name) only ever resolves the unnamed/default entry for
                // that type; named entries require the matching name.
                _ => false,
            })
            .map(|dir| Value::String(dir.path.clone()))
    }

    /// Typed `get()` helper: returns the value as a `String` when present
    /// and JSON-typed as a string.
    pub fn get_str(&self, key: &str) -> Option<String> {
        match self.get(key)? {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    /// Typed `get()` helper: returns the value as an `i64` when present
    /// and JSON-typed as an integer.
    pub fn get_int(&self, key: &str) -> Option<i64> {
        self.get(key)?.as_i64()
    }

    /// Typed `get()` helper: returns the value as an `f64` when present
    /// and JSON-typed as a number.
    pub fn get_number(&self, key: &str) -> Option<f64> {
        self.get(key)?.as_f64()
    }

    /// Typed `get()` helper: returns the value as a `bool` when present
    /// and JSON-typed as a boolean.
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key)?.as_bool()
    }

    /// Returns a reference to the full, deserialized snapshot. Used for
    /// debugging / introspection.
    pub fn to_json(&self) -> &SnapshotData {
        &self.data
    }
}

/// Resolve the default `adhdRoot`: `$ADHD_HOME` if set, else
/// `$HOME/.adhd` (`$USERPROFILE/.adhd` on platforms without `$HOME`).
fn default_adhd_root() -> String {
    if let Ok(root) = env::var("ADHD_HOME") {
        if !root.is_empty() {
            return root;
        }
    }
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{home}/.{DEFAULT_ORG_NAMESPACE}")
}

/// `<adhdRoot>/<project>/<namespace>/adhd-environment.json`
fn resolve_snapshot_path(adhd_root: &str, project: &str, namespace: &str) -> PathBuf {
    PathBuf::from(adhd_root)
        .join(project)
        .join(namespace)
        .join(SNAPSHOT_FILENAME)
}

/// Walks a dot-separated path into a nested `serde_json::Value`, cloning
/// the leaf on success.
fn get_nested(value: &Value, path: &str) -> Option<Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current.clone())
}

/// Parses a `"path.*"` accessor suffix (e.g. `"state.data"` or
/// `"state.data.registry"`) into a known [`DirectoryType`] plus optional
/// disambiguating name. Directory-type wire values are themselves
/// dot-separated, so this matches the longest known type prefix rather
/// than naively splitting on the first dot.
fn parse_path_key(rest: &str) -> Option<(DirectoryType, Option<String>)> {
    for dir_type in DirectoryType::ALL {
        let type_str = dir_type.as_str();
        if rest == type_str {
            return Some((dir_type, None));
        }
        if let Some(remainder) = rest.strip_prefix(type_str) {
            if let Some(name) = remainder.strip_prefix('.') {
                if !name.is_empty() {
                    return Some((dir_type, Some(name.to_string())));
                }
            }
        }
    }
    None
}

// ============================================================================
// Cross-language pure primitives (contract: environment-base-spec)
// ============================================================================
//
// These four functions must reproduce, byte-for-byte / structurally
// identical, the same output as the TypeScript and Python implementations
// for every vector in
// `environment-base-spec/spec/cross-language-test-vectors.json`. That file
// is authoritative; see its `knownDiscrepancy` note for the one place
// where an older prose spec (contentHash({b:"2",a:"1"}) ==
// sha256-9f86d081...) documented an unreachable placeholder value that was
// never actually computed by the algorithm it claims to describe. This
// crate intentionally implements the literal documented algorithm (sorted
// `key=value\n` lines, SHA-256, `sha256-` prefix) and therefore matches
// the vectors file's corrected value
// (sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930),
// not the stale placeholder.

/// `sha256-` + hex(SHA-256(sorted `key=value\n` lines)).
///
/// Input order does not matter: entries are sorted by key before
/// serialization, so `content_hash([("b","2"),("a","1")])` and
/// `content_hash([("a","1"),("b","2")])` produce the identical hash.
///
/// ```
/// use adhd_environment::content_hash;
/// assert_eq!(
///     content_hash([("b", "2"), ("a", "1")]),
///     "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930",
/// );
/// ```
pub fn content_hash<I, K, V>(entries: I) -> String
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let mut pairs: Vec<(String, String)> = entries
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut buf = String::new();
    for (key, value) in &pairs {
        buf.push_str(key);
        buf.push('=');
        buf.push_str(value);
        buf.push('\n');
    }

    let digest = Sha256::digest(buf.as_bytes());
    format!("sha256-{}", to_hex(&digest))
}

/// Infers a project's env var prefix from its (kebab-case) name.
///
/// Algorithm: uppercase the project name, replace `-` and `.` with `_`,
/// and prepend `"ADHD_"`.
///
/// ```
/// use adhd_environment::project_env_prefix;
/// assert_eq!(project_env_prefix("agent-mcp"), "ADHD_AGENT_MCP");
/// assert_eq!(project_env_prefix("decompile-cli"), "ADHD_DECOMPILE_CLI");
/// ```
pub fn project_env_prefix(project_name: &str) -> String {
    let normalized = project_name.to_uppercase().replace(['-', '.'], "_");
    format!("ADHD_{normalized}")
}

/// Infers the env var name for a config field given its resolved prefix
/// and dot-separated field path.
///
/// Algorithm: uppercase the field path, replace `.` and `-` with `_`, and
/// prepend `"{prefix}_"`.
///
/// ```
/// use adhd_environment::infer_env_var;
/// assert_eq!(infer_env_var("ADHD_AGENT_MCP", "db.path"), "ADHD_AGENT_MCP_DB_PATH");
/// ```
pub fn infer_env_var(prefix: &str, field_path: &str) -> String {
    let normalized = field_path.to_uppercase().replace(['.', '-'], "_");
    format!("{prefix}_{normalized}")
}

/// Converts flat, dot-path field definitions into a nested JSON Schema
/// object.
///
/// `{"server.port": {"type": "integer", "minimum": 1024}}` becomes
/// `{"type": "object", "properties": {"server": {"type": "object",
/// "properties": {"port": {"type": "integer", "minimum": 1024}}}}}`.
/// Fields sharing a parent path (e.g. `"db.path"` and `"db.pool.size"`)
/// reuse the same intermediate object node.
///
/// Leaf field definitions are passed through unmodified (any JSON Schema
/// validation keywords they carry — `minimum`, `enum`, `pattern`, etc. —
/// are preserved as-is).
pub fn generate_field_schema(fields: &Map<String, Value>) -> Value {
    let mut properties = Map::new();
    for (path, definition) in fields {
        insert_nested_property(&mut properties, path, definition.clone());
    }

    let mut root = Map::new();
    root.insert("type".to_string(), Value::String("object".to_string()));
    root.insert("properties".to_string(), Value::Object(properties));
    Value::Object(root)
}

/// Inserts `definition` at the (possibly multi-segment) dot-path `path`
/// within `properties`, creating intermediate `{"type":"object",
/// "properties":{}}` nodes as needed and reusing existing ones when
/// multiple fields share a parent.
fn insert_nested_property(properties: &mut Map<String, Value>, path: &str, definition: Value) {
    let mut segments = path.split('.');
    let Some(head) = segments.next() else {
        return;
    };
    let rest: Vec<&str> = segments.collect();

    if rest.is_empty() {
        properties.insert(head.to_string(), definition);
        return;
    }

    let child = properties.entry(head.to_string()).or_insert_with(|| {
        let mut node = Map::new();
        node.insert("type".to_string(), Value::String("object".to_string()));
        node.insert("properties".to_string(), Value::Object(Map::new()));
        Value::Object(node)
    });

    if let Value::Object(node) = child {
        let child_properties = node
            .entry("properties".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(child_properties) = child_properties {
            insert_nested_property(child_properties, &rest.join("."), definition);
        }
    }
}

/// Lowercase hex-encodes `bytes` without pulling in an extra dependency
/// (this crate is deliberately limited to `serde`, `serde_json`, and
/// `sha2`).
fn to_hex(bytes: &[u8]) -> String {
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX_CHARS[(byte >> 4) as usize] as char);
        out.push(HEX_CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// The pinned cross-language test vectors, embedded at compile time so
    /// tests don't depend on the process's current working directory.
    const VECTORS_JSON: &str =
        include_str!("../../environment-base-spec/spec/cross-language-test-vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS_JSON)
            .expect("cross-language-test-vectors.json must parse as JSON")
    }

    // ---- contentHash -------------------------------------------------

    #[test]
    fn content_hash_matches_every_pinned_vector() {
        let vectors = vectors();
        let cases = vectors["contentHash"]
            .as_array()
            .expect("contentHash vectors array");
        assert!(
            !cases.is_empty(),
            "expected at least one contentHash vector"
        );

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = case["input"]
                .as_object()
                .expect("contentHash vector input must be an object");
            let expected = case["expected"]
                .as_str()
                .expect("contentHash vector expected must be a string");

            let pairs: Vec<(String, String)> = input
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_str()
                            .unwrap_or_else(|| {
                                panic!("vector {name}: input values must be strings")
                            })
                            .to_string(),
                    )
                })
                .collect();

            let actual = content_hash(pairs);
            assert_eq!(actual, expected, "contentHash vector '{name}' mismatch");
        }
    }

    #[test]
    fn content_hash_pinned_gate_value() {
        // The single most load-bearing vector, spelled out explicitly per
        // the executor brief (contentHash({b:"2",a:"1"}) ==
        // sha256-4a73850f...).
        assert_eq!(
            content_hash([("b", "2"), ("a", "1")]),
            "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
        );
    }

    #[test]
    fn content_hash_is_order_independent() {
        let unsorted = content_hash([("b", "2"), ("a", "1")]);
        let sorted = content_hash([("a", "1"), ("b", "2")]);
        assert_eq!(unsorted, sorted);
    }

    #[test]
    fn content_hash_of_empty_map_is_empty_string_digest() {
        let empty: Vec<(String, String)> = Vec::new();
        assert_eq!(
            content_hash(empty),
            "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ---- projectEnvPrefix ---------------------------------------------

    #[test]
    fn project_env_prefix_matches_every_pinned_vector() {
        let vectors = vectors();
        let cases = vectors["projectEnvPrefix"]
            .as_array()
            .expect("projectEnvPrefix vectors array");
        assert!(!cases.is_empty());

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = case["input"]
                .as_str()
                .expect("projectEnvPrefix vector input must be a string");
            let expected = case["expected"]
                .as_str()
                .expect("projectEnvPrefix vector expected must be a string");
            assert_eq!(
                project_env_prefix(input),
                expected,
                "projectEnvPrefix vector '{name}' mismatch"
            );
        }
    }

    // ---- inferEnvVar ----------------------------------------------------

    #[test]
    fn infer_env_var_matches_every_pinned_vector() {
        let vectors = vectors();
        let cases = vectors["inferEnvVar"]
            .as_array()
            .expect("inferEnvVar vectors array");
        assert!(!cases.is_empty());

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = &case["input"];
            let prefix = input["prefix"]
                .as_str()
                .expect("inferEnvVar vector input.prefix");
            let field_path = input["fieldPath"]
                .as_str()
                .expect("inferEnvVar vector input.fieldPath");
            let expected = case["expected"]
                .as_str()
                .expect("inferEnvVar vector expected must be a string");
            assert_eq!(
                infer_env_var(prefix, field_path),
                expected,
                "inferEnvVar vector '{name}' mismatch"
            );
        }
    }

    // ---- generateFieldSchema ------------------------------------------

    #[test]
    fn generate_field_schema_matches_every_pinned_vector() {
        let vectors = vectors();
        let cases = vectors["generateFieldSchema"]
            .as_array()
            .expect("generateFieldSchema vectors array");
        assert!(!cases.is_empty());

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = case["input"]
                .as_object()
                .expect("generateFieldSchema vector input must be an object");
            let expected = &case["expected"];

            let actual = generate_field_schema(input);
            // Per the vectors file's documented comparison semantics:
            // generateFieldSchema output is compared by structural/deep
            // equality of the parsed JSON object -- key insertion order is
            // not significant. serde_json::Value's PartialEq for Object
            // compares maps by key/value pairs regardless of insertion
            // order, so a direct `assert_eq!` already implements that
            // semantics.
            assert_eq!(
                &actual, expected,
                "generateFieldSchema vector '{name}' mismatch"
            );
        }
    }

    // ---- Environment: reading a snapshot -------------------------------

    fn fixture_snapshot() -> SnapshotData {
        let mut config = Map::new();
        let mut transport = Map::new();
        transport.insert("port".to_string(), Value::Number(3000.into()));
        config.insert("transport".to_string(), Value::Object(transport));
        let mut db = Map::new();
        db.insert(
            "path".to_string(),
            Value::String("/tmp/db.sqlite".to_string()),
        );
        config.insert("db".to_string(), Value::Object(db));

        let mut raw = BTreeMap::new();
        raw.insert("transport.port".to_string(), "3000".to_string());
        raw.insert("db.path".to_string(), "/tmp/db.sqlite".to_string());

        let mut provenance = BTreeMap::new();
        provenance.insert(
            "transport.port".to_string(),
            ProvenanceEntry {
                source: "project.default".to_string(),
                scope: Scope::Project,
                env: None,
            },
        );
        provenance.insert(
            "db.path".to_string(),
            ProvenanceEntry {
                source: "system.default".to_string(),
                scope: Scope::System,
                env: None,
            },
        );

        let mut env_vars = BTreeMap::new();
        env_vars.insert(
            "ADHD_AGENT_MCP_TRANSPORT_PORT".to_string(),
            "3000".to_string(),
        );

        SnapshotData {
            version: SPEC_VERSION.to_string(),
            library_version: SPEC_VERSION.to_string(),
            generated_at: "2026-07-08T00:00:00.000Z".to_string(),
            project: ProjectIdentity {
                name: "agent-mcp".to_string(),
                org_namespace: "adhd".to_string(),
                env_prefix: "ADHD_AGENT_MCP".to_string(),
                namespace: "default".to_string(),
                description: None,
            },
            config: Value::Object(config),
            raw,
            field_schema: None,
            config_hash: content_hash([("db.path", "/tmp/db.sqlite"), ("transport.port", "3000")]),
            structure_hash:
                "sha256-0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            dirs: vec![
                ResolvedDirectoryEntry {
                    dir_type: DirectoryType::StateData,
                    name: None,
                    path: "/tmp/adhd/agent-mcp/default/data/primary".to_string(),
                    scope: Scope::Project,
                },
                ResolvedDirectoryEntry {
                    dir_type: DirectoryType::StateData,
                    name: Some("registry".to_string()),
                    path: "/tmp/adhd/agent-mcp/default/data/registry".to_string(),
                    scope: Scope::System,
                },
            ],
            provenance,
            env_vars,
        }
    }

    fn write_fixture(root: &Path, project: &str, namespace: &str) -> SnapshotData {
        let snapshot = fixture_snapshot();
        let dir = root.join(project).join(namespace);
        fs::create_dir_all(&dir).expect("create fixture dir");
        let path = dir.join(SNAPSHOT_FILENAME);
        fs::write(&path, serde_json::to_string_pretty(&snapshot).unwrap())
            .expect("write fixture snapshot");
        snapshot
    }

    #[test]
    fn environment_reads_snapshot_and_resolves_config_get() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        let env = Environment::new(
            EnvironmentParams::new("agent-mcp")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string()),
        )
        .expect("environment must construct from fixture");

        assert_eq!(env.project, "agent-mcp");
        assert_eq!(env.namespace, "default");
        assert_eq!(env.org_namespace, "adhd");
        assert_eq!(env.prefix, "ADHD_AGENT_MCP");
        assert_eq!(env.version, SPEC_VERSION);
        assert_eq!(env.get_int("config.transport.port"), Some(3000));
        assert_eq!(
            env.get_str("config.db.path"),
            Some("/tmp/db.sqlite".to_string())
        );
        assert_eq!(env.get("config.missing.field"), None);
    }

    #[test]
    fn environment_resolves_env_and_provenance_paths() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        let env = Environment::new(
            EnvironmentParams::new("agent-mcp")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string()),
        )
        .unwrap();

        assert_eq!(
            env.get_str("env.ADHD_AGENT_MCP_TRANSPORT_PORT"),
            Some("3000".to_string())
        );
        assert_eq!(env.get("env.MISSING"), None);

        let provenance = env
            .get("provenance.transport.port")
            .expect("provenance entry");
        assert_eq!(
            provenance["source"],
            Value::String("project.default".to_string())
        );
        assert_eq!(provenance["scope"], Value::String("project".to_string()));
    }

    #[test]
    fn environment_resolves_path_accessor_with_and_without_name() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        let env = Environment::new(
            EnvironmentParams::new("agent-mcp")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string()),
        )
        .unwrap();

        assert_eq!(
            env.get_str("path.state.data"),
            Some("/tmp/adhd/agent-mcp/default/data/primary".to_string())
        );
        assert_eq!(
            env.get_str("path.state.data.registry"),
            Some("/tmp/adhd/agent-mcp/default/data/registry".to_string())
        );
        assert_eq!(env.get("path.runtime.log"), None);
    }

    #[test]
    fn environment_scope_filter_hides_non_matching_values() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        let system_scoped = Environment::new(
            EnvironmentParams::new("agent-mcp")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string())
                .with_scope(Scope::System),
        )
        .unwrap();

        // db.path's provenance scope is "system" -> visible.
        assert_eq!(
            system_scoped.get_str("config.db.path"),
            Some("/tmp/db.sqlite".to_string())
        );
        // transport.port's provenance scope is "project" -> hidden under a system filter.
        assert_eq!(system_scoped.get("config.transport.port"), None);
        // The "registry" dir is system-scoped -> visible; the unnamed one is project-scoped -> hidden.
        assert_eq!(
            system_scoped.get_str("path.state.data.registry"),
            Some("/tmp/adhd/agent-mcp/default/data/registry".to_string())
        );
        assert_eq!(system_scoped.get("path.state.data"), None);
    }

    #[test]
    fn environment_missing_snapshot_returns_not_found_error() {
        let tmp = tempdir().expect("tempdir");
        let err = Environment::new(
            EnvironmentParams::new("does-not-exist")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string()),
        )
        .expect_err("missing snapshot must error");
        assert!(!err.to_string().is_empty());
        match err {
            EnvironmentError::SnapshotNotFound(path) => {
                assert!(path.ends_with("does-not-exist/default/adhd-environment.json"));
            }
            other => panic!("expected SnapshotNotFound, got {other:?}"),
        }
    }

    #[test]
    fn environment_namespace_defaults_to_default_segment() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        let env = Environment::new(
            EnvironmentParams::new("agent-mcp")
                .with_adhd_root(tmp.path().to_str().unwrap().to_string()),
        )
        .unwrap();
        assert_eq!(env.namespace, DEFAULT_NAMESPACE);
        assert!(env
            .snapshot_path
            .ends_with("agent-mcp/default/adhd-environment.json"));
    }

    #[test]
    fn environment_respects_adhd_home_env_var_when_root_not_supplied() {
        let tmp = tempdir().expect("tempdir");
        write_fixture(tmp.path(), "agent-mcp", "default");

        // SAFETY: tests in this crate do not run env-var-mutating tests in
        // parallel threads that also read ADHD_HOME; this is the only test
        // that sets it and it restores the prior value unconditionally.
        let previous = env::var("ADHD_HOME").ok();
        env::set_var("ADHD_HOME", tmp.path().to_str().unwrap());

        let result = Environment::new(EnvironmentParams::new("agent-mcp"));

        match previous {
            Some(value) => env::set_var("ADHD_HOME", value),
            None => env::remove_var("ADHD_HOME"),
        }

        let env = result.expect("environment must construct via ADHD_HOME fallback");
        assert_eq!(env.get_int("config.transport.port"), Some(3000));
    }

    #[test]
    fn environment_from_snapshot_path_reads_explicit_file() {
        let tmp = tempdir().expect("tempdir");
        let snapshot = write_fixture(tmp.path(), "agent-mcp", "production");
        let explicit_path = tmp
            .path()
            .join("agent-mcp")
            .join("production")
            .join(SNAPSHOT_FILENAME);

        let env = Environment::from_snapshot_path(
            EnvironmentParams::new("agent-mcp").with_namespace("production"),
            &explicit_path,
        )
        .unwrap();

        assert_eq!(env.hash, snapshot.config_hash);
        assert_eq!(env.to_json().project.namespace, "default");
    }

    // ---- Serde round-trip -------------------------------------------------

    #[test]
    fn snapshot_data_serde_round_trip_is_lossless() {
        let snapshot = fixture_snapshot();
        let json = serde_json::to_string(&snapshot).expect("serialize snapshot");
        let roundtripped: SnapshotData = serde_json::from_str(&json).expect("deserialize snapshot");
        assert_eq!(snapshot, roundtripped);
    }

    #[test]
    fn directory_type_wire_values_match_schema_enum() {
        assert_eq!(DirectoryType::StateData.as_str(), "state.data");
        assert_eq!(DirectoryType::RuntimeLog.as_str(), "runtime.log");
        assert_eq!(DirectoryType::RuntimeCache.as_str(), "runtime.cache");
        assert_eq!(DirectoryType::RuntimeTemp.as_str(), "runtime.temp");
    }

    #[test]
    fn scope_from_str_round_trips_through_display() {
        use std::str::FromStr;
        for scope in [Scope::System, Scope::Global, Scope::Project] {
            let parsed = Scope::from_str(&scope.to_string()).unwrap();
            assert_eq!(parsed, scope);
        }
        assert!(Scope::from_str("nonsense").is_err());
    }
}
