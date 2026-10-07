/**
 * views/registry.ts — §3a's registry read surface: `query --input '{"view":"projects"
 * |"components"|"locations"}'`, `query --input '{"view":"lookup", ...}'`, and
 * `get --input '{"registry":..., "name":...}'` (expanded detail).
 *
 * This is deliberately a SEPARATE module from `query.ts`'s issue-verb `query`
 * dispatch — §3a states the registry views are "the agent's go-to before
 * searching," a structural lookup with zero/one answer per input, never a
 * ranked/paginated issue search (§6.1: "conflating the two would be wrong").
 * A transport layer (CLI/MCP/HTTP) composes `query`'s `view` union (`query.ts`)
 * and this module's `listProjects`/`listComponents`/`listLocations`/`lookup`/
 * `getRegistryDetail` under ONE mounted `query`/`get` operation per §3a's own
 * "one convention" — that transport-level merge is out of scope for this
 * file, which exposes each as its own typed function.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import {
  AmbiguousReferenceError,
  CatalogNotFoundError,
  InvalidArgumentError,
} from '../../write/errors.js';
import {
  isUidShaped,
  resolveUidPrefix,
  tryResolveComponentRef,
  tryResolveRef,
} from '../resolve.js';
import { isUidPrefixShaped } from '../../write/uid-prefix.js';
import {
  type IComponentDetail,
  type IComponentSummary,
  type ILocationDetail,
  type ILocationSummary,
  type ILocationType,
  type ILookupResult,
  type IProjectDetail,
  type IProjectSummary,
  type IRegistryFinding,
  type IRegistryQueryFilter,
  MAX_QUERY_LIMIT,
} from '../types.js';

function toProjectSummary(n: NodeRecord): IProjectSummary {
  return {
    uid: n.uid,
    name: n.name ?? '',
    path: typeof n.metadata?.path === 'string' ? n.metadata.path : undefined,
    repoUrl:
      typeof n.metadata?.repoUrl === 'string' ? n.metadata.repoUrl : undefined,
    monorepo:
      typeof n.metadata?.monorepo === 'boolean'
        ? n.metadata.monorepo
        : undefined,
    description:
      typeof n.metadata?.description === 'string'
        ? n.metadata.description
        : undefined,
  };
}

function toComponentSummary(n: NodeRecord): IComponentSummary {
  return {
    uid: n.uid,
    name: n.name ?? '',
    projectUid:
      typeof n.metadata?.projectUid === 'string' ? n.metadata.projectUid : '',
    path: typeof n.metadata?.path === 'string' ? n.metadata.path : undefined,
    description:
      typeof n.metadata?.description === 'string'
        ? n.metadata.description
        : undefined,
  };
}

function toLocationSummary(n: NodeRecord): ILocationSummary {
  return {
    uid: n.uid,
    locType: (typeof n.metadata?.locType === 'string'
      ? n.metadata.locType
      : 'path') as ILocationType,
    value:
      typeof n.metadata?.value === 'string' ? n.metadata.value : n.name ?? '',
    componentUid:
      typeof n.metadata?.componentUid === 'string'
        ? n.metadata.componentUid
        : '',
  };
}

// ---------------------------------------------------------------------------
// registry-orphans — the project-identity detector (39799f8e, S02.C4 / AC16)
// ---------------------------------------------------------------------------

/** The identity keys a project is compared on, strongest evidence first. */
export type IIdentityEvidence = 'repoUrl' | 'path' | 'name-suffix';

/**
 * Normalize one project's identity along ONE axis.
 *
 * - `repoUrl`: lowercased, scheme / `user@` / trailing `.git` / trailing slash
 *   stripped, `host:org/repo` (scp form) folded to `host/org/repo`.
 * - `path`: the canonical absolute path (no trailing slash).
 * - `name-suffix`: the lowercased segment after the last `/` of the NAME.
 *
 * Pure. A `name-suffix` match is evidence for a REVIEWED merge, never an
 * auto-merge (ADR-0007 D3: never auto-links).
 */
export function normalizeProjectIdentity(
  p: { name: string; path?: string; repoUrl?: string },
  evidence: IIdentityEvidence
): string | undefined {
  if (evidence === 'repoUrl') {
    if (p.repoUrl === undefined || p.repoUrl.trim() === '') return undefined;
    let u = p.repoUrl.trim().toLowerCase();
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]+@/, '');
    u = u.replace(/^([^/:]+):(?!\/)/, '$1/');
    u = u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    return u === '' ? undefined : u;
  }
  if (evidence === 'path') {
    if (p.path === undefined || p.path.trim() === '') return undefined;
    const t = p.path.trim().replace(/\/+$/, '');
    return t === '' ? '/' : t;
  }
  const name = p.name.trim().toLowerCase();
  if (name === '') return undefined;
  const suffix = name.slice(name.lastIndexOf('/') + 1);
  return suffix === '' ? undefined : suffix;
}

const IDENTITY_EVIDENCE_ORDER: readonly IIdentityEvidence[] = ['repoUrl', 'path', 'name-suffix'];

/**
 * `query {view:"registry-orphans"}` — the typed findings behind a registry that
 * lists one project per identity. Three finding kinds:
 *
 * - `duplicate-identity`: two or more LIVE projects share a normalized identity.
 *   Each distinct set of uids is reported ONCE, under its strongest evidence.
 *   The second project is reported here, never hidden from `view:"projects"`.
 * - `component-project-mismatch`: a live component whose `meta.projectUid`
 *   disagrees with the project its live `owns_project` edge comes from.
 * - `empty-project`: a live project with no issue owned through any of its
 *   components and no location registered on any of them.
 *
 * Retired (merged) projects carry `t_invalid` and are never examined. After
 * `merge-project` folds a duplicate into its survivor the finding disappears.
 */
export async function listRegistryFindings(
  graph: GraphBackend
): Promise<IRegistryFinding[]> {
  const projects = await graph.queryNodes({ kind: 'project', liveOnly: true });
  const components = await graph.queryNodes({ kind: 'component', liveOnly: true });
  const locations = await graph.queryNodes({ kind: 'location', liveOnly: true });
  const ownsProject = await graph.getEdges({ rel: 'owns_project' });
  const ownsComponent = await graph.getEdges({ rel: 'owns_component' });

  const findings: IRegistryFinding[] = [];

  // duplicate-identity
  const reported = new Set<string>();
  for (const evidence of IDENTITY_EVIDENCE_ORDER) {
    const groups = new Map<string, string[]>();
    for (const n of projects) {
      const summary = toProjectSummary(n);
      const key = normalizeProjectIdentity(summary, evidence);
      if (key === undefined) continue;
      const list = groups.get(key);
      if (list) list.push(n.uid);
      else groups.set(key, [n.uid]);
    }
    for (const [normalized, uids] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (uids.length < 2) continue;
      const sorted = [...uids].sort();
      const setKey = sorted.join('|');
      if (reported.has(setKey)) continue;
      reported.add(setKey);
      findings.push({ kind: 'duplicate-identity', projectUids: sorted, evidence, normalized });
    }
  }

  // component-project-mismatch
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const edgeProjectOfComponent = new Map<number, string>();
  for (const e of ownsProject) {
    const p = projectById.get(e.src);
    if (p) edgeProjectOfComponent.set(e.dst, p.uid);
  }
  for (const c of components) {
    const meta =
      typeof c.metadata?.projectUid === 'string' ? c.metadata.projectUid : '';
    const edge = edgeProjectOfComponent.get(c.id) ?? null;
    if (edge === null || edge !== meta) {
      findings.push({
        kind: 'component-project-mismatch',
        componentUid: c.uid,
        metaProjectUid: meta,
        edgeProjectUid: edge,
      });
    }
  }

  // empty-project
  const componentsByProject = new Map<string, Set<number>>();
  for (const [componentId, projectUid] of edgeProjectOfComponent) {
    const set = componentsByProject.get(projectUid) ?? new Set<number>();
    set.add(componentId);
    componentsByProject.set(projectUid, set);
  }
  const componentUidById = new Map(components.map((c) => [c.id, c.uid]));
  const liveComponentIds = new Set(components.map((c) => c.id));
  const componentsWithIssues = new Set<number>();
  for (const e of ownsComponent) {
    if (liveComponentIds.has(e.src)) componentsWithIssues.add(e.src);
  }
  const componentsWithLocations = new Set<string>();
  for (const l of locations) {
    if (typeof l.metadata?.componentUid === 'string') componentsWithLocations.add(l.metadata.componentUid);
  }
  for (const p of projects) {
    const comps = componentsByProject.get(p.uid) ?? new Set<number>();
    const hasIssue = [...comps].some((id) => componentsWithIssues.has(id));
    const hasLocation = [...comps].some((id) => componentsWithLocations.has(componentUidById.get(id) ?? ''));
    if (!hasIssue && !hasLocation) {
      findings.push({ kind: 'empty-project', projectUid: p.uid, reason: 'no-issues-no-locations' });
    }
  }
  return findings;
}

/** `query --input '{"view":"projects"}'` (§3a) — every live `project` row, optionally narrowed by `filter.project` (name/uid substring is NOT supported here; pass the exact ref — this is a listing view, not a search). */
export async function listProjects(
  graph: GraphBackend,
  filter?: IRegistryQueryFilter
): Promise<IProjectSummary[]> {
  if (filter?.project !== undefined) {
    const resolved = await tryResolveRef(graph, 'project', filter.project);
    return resolved ? [toProjectSummary(resolved.record)] : [];
  }
  const nodes = await graph.queryNodes({ kind: 'project', liveOnly: true });
  return nodes.map(toProjectSummary);
}

/** `query --input '{"view":"components"}'` (§3a) — every live `component` row, optionally narrowed by `filter.project`. */
export async function listComponents(
  graph: GraphBackend,
  filter?: IRegistryQueryFilter
): Promise<IComponentSummary[]> {
  if (filter?.project !== undefined) {
    const project = await tryResolveRef(graph, 'project', filter.project);
    if (!project) return [];
    const nodes = await graph.queryNodes({
      kind: 'component',
      liveOnly: true,
      metadata: { projectUid: { eq: project.uid } },
    });
    return nodes.map(toComponentSummary);
  }
  const nodes = await graph.queryNodes({ kind: 'component', liveOnly: true });
  return nodes.map(toComponentSummary);
}

/** `query --input '{"view":"locations"}'` (§3a) — every live `location` row, optionally narrowed by `filter.component` (scoped within `filter.project` when both are given). */
export async function listLocations(
  graph: GraphBackend,
  filter?: IRegistryQueryFilter
): Promise<ILocationSummary[]> {
  if (filter?.component !== undefined) {
    const component =
      filter.project !== undefined
        ? await (async () => {
            const project = await tryResolveRef(
              graph,
              'project',
              filter.project!
            );
            return project
              ? tryResolveComponentRef(graph, project.uid, filter.component!)
              : null;
          })()
        : await tryResolveRef(graph, 'component', filter.component);
    if (!component) return [];
    const nodes = await graph.queryNodes({
      kind: 'location',
      liveOnly: true,
      metadata: { componentUid: { eq: component.uid } },
    });
    return nodes.map(toLocationSummary);
  }
  const nodes = await graph.queryNodes({ kind: 'location', liveOnly: true });
  return nodes.map(toLocationSummary);
}

/**
 * `get --input '{"registry":"project"|"component"|"location", "name":...}'`
 * (§3a) — expanded detail. `name` accepts a uid or a name (project/component)
 * per SPEC.md §6.1's shape-disambiguation rule; a location has no independent
 * `name`, so it is looked up by uid only. `filter.project` scopes the
 * `component` case (SPEC.md §6.1/§8 AC-23: a bare component NAME is
 * ambiguous across projects — every project's reserved `(root)` component
 * shares the same name — so `filter.project` disambiguates exactly like
 * `listComponents`' own `filter.project`); omitted, `component` resolves
 * against the first live component matching `name` in ANY project, same as
 * before this parameter existed.
 */
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'project'; name: string }
): Promise<IProjectDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'component'; name: string; filter?: IRegistryQueryFilter }
): Promise<IComponentDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'location'; name: string }
): Promise<ILocationDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: {
    registry: 'project' | 'component' | 'location';
    name: string;
    filter?: IRegistryQueryFilter;
  }
): Promise<IProjectDetail | IComponentDetail | ILocationDetail> {
  if (input.registry === 'project') {
    const project = await tryResolveRef(graph, 'project', input.name);
    if (!project) throw new CatalogNotFoundError('project', input.name);
    const componentEdges = await graph.getEdges({
      src: project.id,
      rel: 'owns_project',
    });
    // `getNodesByIds` already defaults `liveOnly` to `true` (verified against
    // `@adhd/sox-graph-store` — an edge surviving past its endpoint's own
    // invalidation cannot leak a tombstoned component here even without this);
    // made explicit for readability/self-documentation of the chain-integrity
    // invariant, not because the default is unsafe.
    const components =
      componentEdges.length > 0
        ? await graph.getNodesByIds(
            componentEdges.map((e) => e.dst),
            { liveOnly: true }
          )
        : [];
    const locationEdgesByComponent = await Promise.all(
      components.map((c) => graph.getEdges({ src: c.id, rel: 'has_location' }))
    );
    const locationIds = locationEdgesByComponent.flatMap((es) =>
      es.map((e) => e.dst)
    );
    const locations =
      locationIds.length > 0
        ? await graph.getNodesByIds(locationIds, { liveOnly: true })
        : [];
    return {
      ...toProjectSummary(project.record),
      components: components.map((c) => ({
        name: c.name ?? '',
        path:
          typeof c.metadata?.path === 'string' ? c.metadata.path : undefined,
      })),
      locations: locations.map((l) => ({
        locType: (typeof l.metadata?.locType === 'string'
          ? l.metadata.locType
          : 'path') as ILocationType,
        value:
          typeof l.metadata?.value === 'string'
            ? l.metadata.value
            : l.name ?? '',
      })),
    };
  }

  if (input.registry === 'component') {
    // `filter.project` disambiguates a bare NAME across projects (§6.1/§8
    // AC-23 — e.g. every project's reserved `(root)` component shares the
    // same name); a uid-shaped `name` is already unambiguous and does not
    // need it, but `tryResolveComponentRef` handles that case identically to
    // `tryResolveRef` (both check-then-return, same shape).
    const scopeProjectRef = input.filter?.project;
    const component =
      scopeProjectRef !== undefined
        ? await (async () => {
            const scopeProject = await tryResolveRef(
              graph,
              'project',
              scopeProjectRef
            );
            if (!scopeProject)
              throw new CatalogNotFoundError('project', scopeProjectRef);
            return tryResolveComponentRef(graph, scopeProject.uid, input.name);
          })()
        : await tryResolveRef(graph, 'component', input.name);
    if (!component) throw new CatalogNotFoundError('component', input.name);
    const projectUid =
      typeof component.record.metadata?.projectUid === 'string'
        ? component.record.metadata.projectUid
        : undefined;
    // `getNodeByUid` has no `liveOnly` filter (unlike `getNodesByIds`), so an
    // invalidated project row must be rejected explicitly — a tombstoned
    // secondary chase must degrade the same as an unresolved one (§3a chain
    // integrity), never surface a soft-deleted project's data as live.
    const projectNode = projectUid
      ? await graph.getNodeByUid(projectUid)
      : null;
    const project = projectNode && !projectNode.tInvalid ? projectNode : null;
    const locationEdges = await graph.getEdges({
      src: component.id,
      rel: 'has_location',
    });
    const locations =
      locationEdges.length > 0
        ? await graph.getNodesByIds(
            locationEdges.map((e) => e.dst),
            { liveOnly: true }
          )
        : [];
    return {
      ...toComponentSummary(component.record),
      project: {
        name: project?.name ?? '',
        path:
          typeof project?.metadata?.path === 'string'
            ? project.metadata.path
            : undefined,
        repoUrl:
          typeof project?.metadata?.repoUrl === 'string'
            ? project.metadata.repoUrl
            : undefined,
      },
      locations: locations.map((l) => ({
        locType: (typeof l.metadata?.locType === 'string'
          ? l.metadata.locType
          : 'path') as ILocationType,
        value:
          typeof l.metadata?.value === 'string'
            ? l.metadata.value
            : l.name ?? '',
      })),
    };
  }

  // location — uid only (no independent business name, §3a). An exact uid or
  // a UNIQUE uid prefix resolves; `resolveUidPrefix` throws
  // `AmbiguousReferenceError` on a multi-match and `CatalogNotFoundError` on a
  // miss, exactly as the previous exact-only read did.
  if (!isUidShaped(input.name) && !isUidPrefixShaped(input.name))
    throw new InvalidArgumentError(
      'name',
      'a location has no name — pass its uid'
    );
  const location = await resolveUidPrefix(graph, input.name, {
    expectedKind: 'location',
  });
  const componentUid =
    typeof location.metadata?.componentUid === 'string'
      ? location.metadata.componentUid
      : undefined;
  // Same tombstone-rejection as the `component` branch above — a soft-deleted
  // component/project must not resurface via a location's secondary chase.
  const componentNodeRaw = componentUid
    ? await graph.getNodeByUid(componentUid)
    : null;
  const component =
    componentNodeRaw && !componentNodeRaw.tInvalid ? componentNodeRaw : null;
  const projectUid =
    typeof component?.metadata?.projectUid === 'string'
      ? component.metadata.projectUid
      : undefined;
  const projectNodeRaw = projectUid
    ? await graph.getNodeByUid(projectUid)
    : null;
  const project =
    projectNodeRaw && !projectNodeRaw.tInvalid ? projectNodeRaw : null;
  return {
    ...toLocationSummary(location),
    component: {
      name: component?.name ?? '',
      path:
        typeof component?.metadata?.path === 'string'
          ? component.metadata.path
          : undefined,
    },
    project: {
      name: project?.name ?? '',
      path:
        typeof project?.metadata?.path === 'string'
          ? project.metadata.path
          : undefined,
      repoUrl:
        typeof project?.metadata?.repoUrl === 'string'
          ? project.metadata.repoUrl
          : undefined,
    },
  };
}

function looksLikeUrl(q: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(q);
    return true;
  } catch {
    return false;
  }
}

function classifyLookupQuery(q: string): ILocationType {
  if (looksLikeUrl(q)) return 'url';
  if (q.includes('/') || q.includes('.') || q.startsWith('~')) return 'path';
  return 'tool';
}

/**
 * The optional kind HINT `lookup` accepts (C1, §3a). `q` is the token to
 * resolve; `kind` narrows which routing branch runs, so a caller that already
 * knows it is holding an issue uid or a project name can suppress the other
 * branches instead of relying on the default precedence.
 */
export interface ILookupInput {
  q: string;
  /** optional: `'location' | 'project' | 'component' | 'issue'` */
  kind?: string;
}

/** The outcome of the location-classify→match→walk branch: a match, or a miss that carries whether the path fallback was truncated. */
type LocationLookupOutcome =
  | { ok: true; result: ILookupResult }
  | { ok: false; truncated: boolean };

/**
 * The `location` branch of {@link lookup} — classify → match → walk
 * `location → component → project` (§3a). Returns `{ ok: false }` on a miss
 * (rather than throwing) so `lookup` can fall through to its later branches;
 * the truncation flag is carried so the final not-found error can preserve the
 * existing "a match may exist beyond this cap" caveat.
 */
async function lookupLocation(
  graph: GraphBackend,
  q: string
): Promise<LocationLookupOutcome> {
  const locType = classifyLookupQuery(q);

  let location = (
    await graph.queryNodes({
      kind: 'location',
      liveOnly: true,
      metadata: { locType: { eq: locType }, value: { eq: q } },
      limit: 1,
    })
  )[0];

  let hint: string | undefined;
  let pathFallbackTruncated = false;
  if (!location && locType === 'path') {
    // Suffix/prefix fallback for repo-relative paths (§3a step 2). `MetadataFilter`
    // has no suffix/prefix/LIKE operator (see `sox-graph-store`'s `MetadataFilter`),
    // so the `value.endsWith(q) || q.endsWith(value)` scan below cannot be pushed
    // into `queryNodes` — it must run in memory. What CAN move server-side is the
    // row count: bound the fetch at `MAX_QUERY_LIMIT` (the same ceiling every other
    // view in this module enforces) instead of pulling every live path location in
    // the store on every miss. Request one row past the cap so truncation is
    // detectable without a second round trip.
    const candidates = await graph.queryNodes({
      kind: 'location',
      liveOnly: true,
      metadata: { locType: { eq: 'path' } },
      limit: MAX_QUERY_LIMIT + 1,
    });
    pathFallbackTruncated = candidates.length > MAX_QUERY_LIMIT;
    const scanned = pathFallbackTruncated
      ? candidates.slice(0, MAX_QUERY_LIMIT)
      : candidates;
    const match = scanned.find((c) => {
      const value =
        typeof c.metadata?.value === 'string' ? c.metadata.value : '';
      return value.endsWith(q) || q.endsWith(value);
    });
    if (match) {
      location = match;
      // A truncated scan that still found a match within the first MAX_QUERY_LIMIT
      // candidates is a genuine match, not a false positive — no extra caveat needed.
      hint = `matched by path suffix/prefix fallback, not an exact value match`;
    }
  }

  if (!location) {
    return { ok: false, truncated: pathFallbackTruncated };
  }

  const componentUid =
    typeof location.metadata?.componentUid === 'string'
      ? location.metadata.componentUid
      : undefined;
  // A tombstoned component must resolve the same as a missing one — `lookup`
  // never surfaces a soft-deleted row as though it were live (§3a chain
  // integrity; `getNodeByUid` has no `liveOnly` filter, so this must be
  // checked explicitly).
  const componentRaw = componentUid
    ? await graph.getNodeByUid(componentUid)
    : null;
  const component =
    componentRaw && !componentRaw.tInvalid ? componentRaw : null;
  if (!component) {
    throw new CatalogNotFoundError('component', componentUid ?? '(unresolved)');
  }
  const projectUid =
    typeof component.metadata?.projectUid === 'string'
      ? component.metadata.projectUid
      : undefined;
  const projectRaw = projectUid ? await graph.getNodeByUid(projectUid) : null;
  const project = projectRaw && !projectRaw.tInvalid ? projectRaw : null;
  if (!project) {
    return {
      ok: true,
      result: {
        project: { uid: '', name: '' },
        component: { uid: component.uid, name: component.name ?? '' },
        location: { uid: location.uid, locType, value: q },
        hint: 'component resolved but its owning project could not be found — data integrity gap, not a query error',
      },
    };
  }

  return {
    ok: true,
    result: {
      project: {
        uid: project.uid,
        name: project.name ?? '',
        path:
          typeof project.metadata?.path === 'string'
            ? project.metadata.path
            : undefined,
        repoUrl:
          typeof project.metadata?.repoUrl === 'string'
            ? project.metadata.repoUrl
            : undefined,
      },
      component: {
        uid: component.uid,
        name: component.name ?? '',
        path:
          typeof component.metadata?.path === 'string'
            ? component.metadata.path
            : undefined,
      },
      location: {
        uid: location.uid,
        locType,
        value:
          typeof location.metadata?.value === 'string'
            ? location.metadata.value
            : q,
      },
      hint,
    },
  };
}

/**
 * `query --input '{"view":"lookup", "lookup": "<tool|file|url|uid|title|project>"}'`
 * (§3a, C1 AC4) — resolve ANY token a consumer holds to exactly one canonical
 * answer, or fail loudly naming what was searched.
 *
 * Routing order (C1 spec, fixed):
 *  1. a uid or uid PREFIX → a `redirect` to `get` (the registry shape does not
 *     apply to a node reached by identity);
 *  2. an issue TITLE → exactly one hit redirects to `get`; ≥2 is
 *     `AmbiguousReferenceError`; zero falls through;
 *  3. the existing location classify→match→walk;
 *  4. a project `name`/`repoUrl` match;
 *  then `CatalogNotFoundError('location', q)` — `lookup` is never a silent null.
 *
 * Existing location-only consumers keep working: their exact-path query misses
 * the uid/title/project branches and is served by step 3 unchanged.
 */
export async function lookup(
  graph: GraphBackend,
  input: string | ILookupInput
): Promise<ILookupResult> {
  const q = typeof input === 'string' ? input : input.q;
  const kind = typeof input === 'string' ? undefined : input.kind;
  const wantIssue = kind === undefined || kind === 'issue';
  const wantLocation = kind === undefined || kind === 'location';
  const wantProject = kind === undefined || kind === 'project';
  const wantComponent = kind === undefined || kind === 'component';

  // (1) uid / uid prefix → forward to `get`. A uid is identity, not registry
  // shape, so the project/component/location fields stay empty (the established
  // "no registry match" sentinel) and the caller is told where to look.
  if (isUidShaped(q) || isUidPrefixShaped(q)) {
    const record = await resolveUidPrefix(graph, q);
    return {
      project: { uid: '', name: '' },
      redirect: { verb: 'get', uid: record.uid },
    };
  }

  // (2) issue TITLE — match the issue's `name` column only, never its BODY.
  // `graph.searchNodes` hard-codes its FTS columns to `content`/`name`/`summary`
  // (`@adhd/sox-graph-store` dist/index.js `searchNodes`), and an ISSUE's
  // `content` is its BODY (`write/create-issue.ts` writes `content: input.body`).
  // A raw FTS hit can therefore come from the body alone; treating every hit as
  // a title match let a body-only match shadow the location/project branches
  // below — `lookup({q:'adhd'})` redirected to an issue whose body merely
  // mentioned "adhd", or threw `AmbiguousReferenceError` when two bodies did.
  // The store exposes no name-scoped FTS, so re-filter the (already token-OR'd)
  // hits by title: a hit counts only when one of `q`'s whitespace tokens — the
  // same tokenization `searchNodes` applies — appears in its `name`.
  if (wantIssue) {
    const titleTokens = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const hits = (
      await graph.searchNodes(q, {
        filter: { kind: 'issue', liveOnly: true, isSuperseded: false },
        limit: 20,
      })
    ).filter((h) =>
      titleTokens.some((t) => (h.name ?? '').toLowerCase().includes(t))
    );
    if (hits.length === 1) {
      return {
        project: { uid: '', name: '' },
        redirect: { verb: 'get', uid: hits[0].uid },
      };
    }
    if (hits.length > 1) {
      throw new AmbiguousReferenceError(
        q,
        hits.map((h) => ({ uid: h.uid, kind: h.kind, name: h.name ?? '' }))
      );
    }
  }

  // (3) location classify→match→walk (the original behaviour, preserved).
  let locationTruncated = false;
  if (wantLocation) {
    const loc = await lookupLocation(graph, q);
    if (loc.ok) return loc.result;
    locationTruncated = loc.truncated;
  }

  // (4) project by exact `name`, else by `repoUrl`.
  if (wantProject) {
    const byName = await graph.queryNodes({
      kind: 'project',
      name: q,
      liveOnly: true,
      limit: 1,
    });
    const project =
      byName[0] ??
      (
        await graph.queryNodes({
          kind: 'project',
          liveOnly: true,
          metadata: { repoUrl: { eq: q } },
          limit: 1,
        })
      )[0];
    if (project) {
      return {
        project: toProjectSummary(project),
        hint: 'matched a project by name/repoUrl — no component or location was requested',
      };
    }
  }

  // (4b) component by name/uid (the `kind:'component'` hint's natural analogue).
  if (wantComponent && kind === 'component') {
    const component = await tryResolveRef(graph, 'component', q);
    if (component) {
      const projectUid =
        typeof component.record.metadata?.projectUid === 'string'
          ? component.record.metadata.projectUid
          : undefined;
      const projectNode = projectUid
        ? await graph.getNodeByUid(projectUid)
        : null;
      return {
        project:
          projectNode && !projectNode.tInvalid
            ? toProjectSummary(projectNode)
            : { uid: '', name: '' },
        component: toComponentSummary(component.record),
        hint: 'matched a component by name/uid',
      };
    }
  }

  throw new CatalogNotFoundError(
    'location',
    locationTruncated
      ? `${q} (path suffix/prefix fallback scanned only the first ${MAX_QUERY_LIMIT} live path locations; a match may exist beyond this cap)`
      : q
  );
}
