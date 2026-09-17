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
import { CatalogNotFoundError, InvalidArgumentError } from '../../write/errors.js';
import { isUidShaped, tryResolveComponentRef, tryResolveRef } from '../resolve.js';
import {
  type IComponentDetail,
  type IComponentSummary,
  type ILocationDetail,
  type ILocationSummary,
  type ILocationType,
  type ILookupResult,
  type IProjectDetail,
  type IProjectSummary,
  type IRegistryQueryFilter,
  MAX_QUERY_LIMIT,
} from '../types.js';

function toProjectSummary(n: NodeRecord): IProjectSummary {
  return {
    uid: n.uid,
    name: n.name ?? '',
    path: typeof n.metadata?.path === 'string' ? n.metadata.path : undefined,
    repoUrl: typeof n.metadata?.repoUrl === 'string' ? n.metadata.repoUrl : undefined,
    monorepo: typeof n.metadata?.monorepo === 'boolean' ? n.metadata.monorepo : undefined,
    description: typeof n.metadata?.description === 'string' ? n.metadata.description : undefined,
  };
}

function toComponentSummary(n: NodeRecord): IComponentSummary {
  return {
    uid: n.uid,
    name: n.name ?? '',
    projectUid: typeof n.metadata?.projectUid === 'string' ? n.metadata.projectUid : '',
    path: typeof n.metadata?.path === 'string' ? n.metadata.path : undefined,
    description: typeof n.metadata?.description === 'string' ? n.metadata.description : undefined,
  };
}

function toLocationSummary(n: NodeRecord): ILocationSummary {
  return {
    uid: n.uid,
    locType: (typeof n.metadata?.locType === 'string' ? n.metadata.locType : 'path') as ILocationType,
    value: typeof n.metadata?.value === 'string' ? n.metadata.value : (n.name ?? ''),
    componentUid: typeof n.metadata?.componentUid === 'string' ? n.metadata.componentUid : '',
  };
}

/** `query --input '{"view":"projects"}'` (§3a) — every live `project` row, optionally narrowed by `filter.project` (name/uid substring is NOT supported here; pass the exact ref — this is a listing view, not a search). */
export async function listProjects(graph: GraphBackend, filter?: IRegistryQueryFilter): Promise<IProjectSummary[]> {
  if (filter?.project !== undefined) {
    const resolved = await tryResolveRef(graph, 'project', filter.project);
    return resolved ? [toProjectSummary(resolved.record)] : [];
  }
  const nodes = await graph.queryNodes({ kind: 'project', liveOnly: true });
  return nodes.map(toProjectSummary);
}

/** `query --input '{"view":"components"}'` (§3a) — every live `component` row, optionally narrowed by `filter.project`. */
export async function listComponents(graph: GraphBackend, filter?: IRegistryQueryFilter): Promise<IComponentSummary[]> {
  if (filter?.project !== undefined) {
    const project = await tryResolveRef(graph, 'project', filter.project);
    if (!project) return [];
    const nodes = await graph.queryNodes({ kind: 'component', liveOnly: true, metadata: { projectUid: { eq: project.uid } } });
    return nodes.map(toComponentSummary);
  }
  const nodes = await graph.queryNodes({ kind: 'component', liveOnly: true });
  return nodes.map(toComponentSummary);
}

/** `query --input '{"view":"locations"}'` (§3a) — every live `location` row, optionally narrowed by `filter.component` (scoped within `filter.project` when both are given). */
export async function listLocations(graph: GraphBackend, filter?: IRegistryQueryFilter): Promise<ILocationSummary[]> {
  if (filter?.component !== undefined) {
    const component = filter.project !== undefined
      ? await (async () => {
        const project = await tryResolveRef(graph, 'project', filter.project!);
        return project ? tryResolveComponentRef(graph, project.uid, filter.component!) : null;
      })()
      : await tryResolveRef(graph, 'component', filter.component);
    if (!component) return [];
    const nodes = await graph.queryNodes({ kind: 'location', liveOnly: true, metadata: { componentUid: { eq: component.uid } } });
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
  input: { registry: 'project'; name: string },
): Promise<IProjectDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'component'; name: string; filter?: IRegistryQueryFilter },
): Promise<IComponentDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'location'; name: string },
): Promise<ILocationDetail>;
export async function getRegistryDetail(
  graph: GraphBackend,
  input: { registry: 'project' | 'component' | 'location'; name: string; filter?: IRegistryQueryFilter },
): Promise<IProjectDetail | IComponentDetail | ILocationDetail> {
  if (input.registry === 'project') {
    const project = await tryResolveRef(graph, 'project', input.name);
    if (!project) throw new CatalogNotFoundError('project', input.name);
    const componentEdges = await graph.getEdges({ src: project.id, rel: 'owns_project' });
    // `getNodesByIds` already defaults `liveOnly` to `true` (verified against
    // `@adhd/sox-graph-store` — an edge surviving past its endpoint's own
    // invalidation cannot leak a tombstoned component here even without this);
    // made explicit for readability/self-documentation of the chain-integrity
    // invariant, not because the default is unsafe.
    const components = componentEdges.length > 0 ? await graph.getNodesByIds(componentEdges.map((e) => e.dst), { liveOnly: true }) : [];
    const locationEdgesByComponent = await Promise.all(components.map((c) => graph.getEdges({ src: c.id, rel: 'has_location' })));
    const locationIds = locationEdgesByComponent.flatMap((es) => es.map((e) => e.dst));
    const locations = locationIds.length > 0 ? await graph.getNodesByIds(locationIds, { liveOnly: true }) : [];
    return {
      ...toProjectSummary(project.record),
      components: components.map((c) => ({ name: c.name ?? '', path: typeof c.metadata?.path === 'string' ? c.metadata.path : undefined })),
      locations: locations.map((l) => ({
        locType: (typeof l.metadata?.locType === 'string' ? l.metadata.locType : 'path') as ILocationType,
        value: typeof l.metadata?.value === 'string' ? l.metadata.value : (l.name ?? ''),
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
    const component = scopeProjectRef !== undefined
      ? await (async () => {
        const scopeProject = await tryResolveRef(graph, 'project', scopeProjectRef);
        if (!scopeProject) throw new CatalogNotFoundError('project', scopeProjectRef);
        return tryResolveComponentRef(graph, scopeProject.uid, input.name);
      })()
      : await tryResolveRef(graph, 'component', input.name);
    if (!component) throw new CatalogNotFoundError('component', input.name);
    const projectUid = typeof component.record.metadata?.projectUid === 'string' ? component.record.metadata.projectUid : undefined;
    // `getNodeByUid` has no `liveOnly` filter (unlike `getNodesByIds`), so an
    // invalidated project row must be rejected explicitly — a tombstoned
    // secondary chase must degrade the same as an unresolved one (§3a chain
    // integrity), never surface a soft-deleted project's data as live.
    const projectNode = projectUid ? await graph.getNodeByUid(projectUid) : null;
    const project = projectNode && !projectNode.tInvalid ? projectNode : null;
    const locationEdges = await graph.getEdges({ src: component.id, rel: 'has_location' });
    const locations = locationEdges.length > 0 ? await graph.getNodesByIds(locationEdges.map((e) => e.dst), { liveOnly: true }) : [];
    return {
      ...toComponentSummary(component.record),
      project: {
        name: project?.name ?? '',
        path: typeof project?.metadata?.path === 'string' ? project.metadata.path : undefined,
        repoUrl: typeof project?.metadata?.repoUrl === 'string' ? project.metadata.repoUrl : undefined,
      },
      locations: locations.map((l) => ({
        locType: (typeof l.metadata?.locType === 'string' ? l.metadata.locType : 'path') as ILocationType,
        value: typeof l.metadata?.value === 'string' ? l.metadata.value : (l.name ?? ''),
      })),
    };
  }

  // location — uid only (no independent business name, §3a)
  if (!isUidShaped(input.name)) throw new InvalidArgumentError('name', 'a location has no name — pass its uid');
  const location = await graph.getNodeByUid(input.name);
  if (!location || location.kind !== 'location' || location.tInvalid) throw new CatalogNotFoundError('location', input.name);
  const componentUid = typeof location.metadata?.componentUid === 'string' ? location.metadata.componentUid : undefined;
  // Same tombstone-rejection as the `component` branch above — a soft-deleted
  // component/project must not resurface via a location's secondary chase.
  const componentNodeRaw = componentUid ? await graph.getNodeByUid(componentUid) : null;
  const component = componentNodeRaw && !componentNodeRaw.tInvalid ? componentNodeRaw : null;
  const projectUid = typeof component?.metadata?.projectUid === 'string' ? component.metadata.projectUid : undefined;
  const projectNodeRaw = projectUid ? await graph.getNodeByUid(projectUid) : null;
  const project = projectNodeRaw && !projectNodeRaw.tInvalid ? projectNodeRaw : null;
  return {
    ...toLocationSummary(location),
    component: { name: component?.name ?? '', path: typeof component?.metadata?.path === 'string' ? component.metadata.path : undefined },
    project: {
      name: project?.name ?? '',
      path: typeof project?.metadata?.path === 'string' ? project.metadata.path : undefined,
      repoUrl: typeof project?.metadata?.repoUrl === 'string' ? project.metadata.repoUrl : undefined,
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
 * `query --input '{"view":"lookup", "lookup": "<tool|file|url>"}'` (§3a) —
 * classify → match → walk `location → component → project`. Never a silent
 * null: an unresolved query throws `CatalogNotFoundError('location', q)`
 * rather than returning an empty/undefined result, since "no match" is a
 * distinct, actionable outcome from "found, but only a hint" (the `hint`
 * field below).
 */
export async function lookup(graph: GraphBackend, q: string): Promise<ILookupResult> {
  const locType = classifyLookupQuery(q);

  let location = (await graph.queryNodes({ kind: 'location', liveOnly: true, metadata: { locType: { eq: locType }, value: { eq: q } }, limit: 1 }))[0];

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
    const scanned = pathFallbackTruncated ? candidates.slice(0, MAX_QUERY_LIMIT) : candidates;
    const match = scanned.find((c) => {
      const value = typeof c.metadata?.value === 'string' ? c.metadata.value : '';
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
    // A truncated fallback scan that found nothing is NOT the same claim as an
    // exhaustive "not found" — surface that distinction rather than silently
    // reporting a false negative as though every path location had been checked.
    throw new CatalogNotFoundError(
      'location',
      pathFallbackTruncated
        ? `${q} (path suffix/prefix fallback scanned only the first ${MAX_QUERY_LIMIT} live path locations; a match may exist beyond this cap)`
        : q,
    );
  }

  const componentUid = typeof location.metadata?.componentUid === 'string' ? location.metadata.componentUid : undefined;
  // A tombstoned component must resolve the same as a missing one — `lookup`
  // never surfaces a soft-deleted row as though it were live (§3a chain
  // integrity; `getNodeByUid` has no `liveOnly` filter, so this must be
  // checked explicitly).
  const componentRaw = componentUid ? await graph.getNodeByUid(componentUid) : null;
  const component = componentRaw && !componentRaw.tInvalid ? componentRaw : null;
  if (!component) {
    throw new CatalogNotFoundError('component', componentUid ?? '(unresolved)');
  }
  const projectUid = typeof component.metadata?.projectUid === 'string' ? component.metadata.projectUid : undefined;
  const projectRaw = projectUid ? await graph.getNodeByUid(projectUid) : null;
  const project = projectRaw && !projectRaw.tInvalid ? projectRaw : null;
  if (!project) {
    return {
      project: { uid: '', name: '' },
      component: { uid: component.uid, name: component.name ?? '' },
      location: { uid: location.uid, locType, value: q },
      hint: 'component resolved but its owning project could not be found — data integrity gap, not a query error',
    };
  }

  return {
    project: {
      uid: project.uid,
      name: project.name ?? '',
      path: typeof project.metadata?.path === 'string' ? project.metadata.path : undefined,
      repoUrl: typeof project.metadata?.repoUrl === 'string' ? project.metadata.repoUrl : undefined,
    },
    component: { uid: component.uid, name: component.name ?? '', path: typeof component.metadata?.path === 'string' ? component.metadata.path : undefined },
    location: { uid: location.uid, locType, value: typeof location.metadata?.value === 'string' ? location.metadata.value : q },
    hint,
  };
}
