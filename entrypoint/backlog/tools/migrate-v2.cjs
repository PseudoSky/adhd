'use strict';
/**
 * migrate-v2.cjs — FRESH-WRITE ETL (DATA_MODEL_v2.md §9), with EMBEDDINGS.
 *
 * The old store file is NEVER modified. This script:
 *   1. READS the old store via its public API (read-only).
 *   2. WRITES a brand-new v2 store through the REAL graph substrate
 *      (`@adhd/sox-store-adapter` turso + `@adhd/sox-graph-store`'s
 *      createGraphBackend with an injected v2 TypePolicy) — open schema,
 *      first-class node/edge kinds, typed edges, batched writeGraph.
 *   3. ENABLES EMBEDDINGS in the SAME fresh db: fastembed bge-base-en-v1.5 via
 *      `@adhd/sox-embedding-provider`, vector table via `@adhd/sox-vector-store`
 *      openTursoVectorStore(adapter) — one upsert per issue (title+body).
 *      First run downloads the model (~130MB) — set a generous timeout.
 *
 * Usage: node migrate-v2.cjs <oldDbPath> <newDbPath>
 * Env:   MIGRATE_DIST = absolute path to the built backlog dist/index.js
 *
 * First-cut scope (explicitly stubbed / decided conservatively):
 *   - Projects: one per DISTINCT old repo string — NO silent merging; fork
 *     candidates reported for the explicit reconcile decision.
 *   - Components: per distinct (project, projectPath); 'unassigned' bucket.
 *   - Catalogs are nodes; issues link via has_kind/has_status/has_priority/
 *     authored_by edges. Notes/citations/transitions are nodes via
 *     has_note/has_citation/has_transition edges.
 *   - Citation sha: sha256 of target file content when readable, else
 *     reference-addressed sha (sha_verified=0, logged).
 *   - Transitions: from audit 'transition' events; no historical notes →
 *     audit detail verbatim + note_synthesized flag; sha = canonical hash.
 *   - depends_on / has_location: no source data — not written.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createStoreAdapter } = require('@adhd/sox-store-adapter');
const { createGraphBackend, ConstraintError } = require('@adhd/sox-graph-store');
const { createEmbeddingProvider } = require('@adhd/sox-embedding-provider');
const { openTursoVectorStore } = require('@adhd/sox-vector-store');

const DIST = process.env.MIGRATE_DIST || '/Users/nix/dev/node/adhd/entrypoint/backlog/dist/index.js';
const { openGraphBacklogStore, closeGraphBacklogStore, buildBacklogEnv, query, get } = require(DIST);

const oldDbPath = process.argv[2];
const newDbPath = process.argv[3];
if (!oldDbPath || !newDbPath) {
  console.error('usage: node migrate-v2.cjs <oldDbPath> <newDbPath>');
  process.exit(2);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const shaFile = (p) => { try { return sha(fs.readFileSync(p)); } catch { return null; } };

const V2_KINDS = new Set([
  'project', 'component', 'location', 'issue', 'agent',
  'status', 'priority', 'kind', 'edge_kind',
  'note', 'citation', 'transition',
]);
const V2_RELS = new Set([
  'owns_project', 'owns_component', 'depends_on', 'has_location',
  'has_status', 'has_priority', 'has_kind', 'authored_by',
  'has_note', 'has_citation', 'has_transition',
  'relates_to', 'supersedes', 'blocks', 'duplicate_of', 'part_of',
]);

const TERMINAL_STATUSES = new Set(['FIXED','RESOLVED','DONE','SHIPPED','VERIFIED','REMOVED','MITIGATED','SUPERSEDED','INVALID','DUPLICATE','WONTFIX']);
const ALL_STATUSES = ['OPEN','IN_PROGRESS','PARTIAL','OUTSTANDING','DEFERRED','BLOCKED','MIXED','UNKNOWN','FIXED','RESOLVED','DONE','SHIPPED','VERIFIED','REMOVED','MITIGATED','SUPERSEDED','INVALID','DUPLICATE','WONTFIX'];
const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const EMBEDDING_MODEL = { type: 'fastembed', model: 'bge-base-en-v1.5' };

function canonicalAgent(s) {
  const v = String(s || '').trim();
  if (!v) return 'unknown';
  const m = v.match(/^([a-z0-9_-]+)/i);
  return m ? m[1] : v;
}

const ALL_FIELDS = ['repo', 'projectPath', 'body', 'citations', 'notes', 'audit_trail', 'related', 'rollup', 'blockers'];

async function readOldStore() {
  const env = buildBacklogEnv({ adhdRoot: path.dirname(oldDbPath) });
  const store = await openGraphBacklogStore(oldDbPath, 5000);
  const ctx = { store, env };
  const seen = new Map();
  for (const status of ['open', 'closed']) {
    let offset = 0;
    for (;;) {
      const res = await query(ctx, { view: 'list', filter: { status }, limit: 500, offset, fields: ['repo', 'projectPath'] });
      const data = res && typeof res === 'object' && 'ok' in res ? (res.ok ? res.data : null) : res;
      if (!data) throw new Error(`query failed: ${JSON.stringify(res && res.error || res)}`);
      const items = data.items || [];
      for (const it of items) seen.set(`${it.repo}::${it.humanId}`, it);
      if (items.length < 500) break;
      offset += items.length;
    }
  }
  const full = [];
  const limit = process.env.MIGRATE_LIMIT ? Number(process.env.MIGRATE_LIMIT) : Infinity;
  for (const it of seen.values()) {
    if (full.length >= limit) break;
    const res = await get(ctx, { humanId: it.humanId, repo: it.repo, fields: ALL_FIELDS });
    const d = res && typeof res === 'object' && 'ok' in res ? (res.ok ? res.data : null) : res;
    if (!d) { console.error(`  WARN: get failed for ${it.repo}::${it.humanId}`); continue; }
    full.push(d);
  }
  await closeGraphBacklogStore(store);
  return full;
}

(async () => {
  console.log(`[migrate-v2] reading old store (read-only): ${oldDbPath}`);
  let items = await readOldStore();
  if (process.env.MIGRATE_LIMIT) {
    items = items.slice(0, Number(process.env.MIGRATE_LIMIT));
    console.log(`[migrate-v2] MIGRATE_LIMIT=${process.env.MIGRATE_LIMIT} — processing ${items.length} items`);
  }
  console.log(`[migrate-v2] read ${items.length} items`);

  fs.mkdirSync(path.dirname(newDbPath), { recursive: true });
  const adapter = await createStoreAdapter({ dbPath: newDbPath });
  const graph = createGraphBackend(adapter, {
    typePolicy: {
      validateKind: (k) => { if (!V2_KINDS.has(k)) throw new ConstraintError(`v2: unknown node kind '${k}'`); },
      validateRel: (r) => { if (!V2_RELS.has(r)) throw new ConstraintError(`v2: unknown edge rel '${r}'`); },
    },
  });
  await graph.applySchema();
  console.log('[migrate-v2] fresh v2 store created (open schema, TypePolicy injected)');

  // --- ONE batched writeGraph: every node + every edge, index-referenced ---
  const allNodes = []; // {content, meta}
  const allEdges = []; // {srcIdx, dstIdx, rel}
  const nodeIndex = new Map(); // logical key -> index in allNodes
  const nodeIdx = (key) => { const i = nodeIndex.get(key); if (i === undefined) throw new Error(`nodeIndex miss: ${key}`); return i; };
  const addNode = (key, content, meta) => { const i = allNodes.length; allNodes.push({ content, meta }); nodeIndex.set(key, i); return i; };

  // catalogs
  for (const s of ALL_STATUSES) addNode(`status:${s}`, s, { kind: 'status', name: s, metadata: { terminal: TERMINAL_STATUSES.has(s) } });
  for (const [p, r] of Object.entries(PRIORITY_RANK)) addNode(`priority:${p}`, p, { kind: 'priority', name: p, metadata: { rank: r } });
  const catalogKinds = [...new Set(['project','component','location','issue','agent', ...items.map((i) => (i.kind || 'BUG').toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'BUG')])];
  for (const k of catalogKinds) addNode(`kind:${k}`, k, { kind: 'kind', name: k });
  for (const r of V2_RELS) addNode(`edge_kind:${r}`, r, { kind: 'edge_kind', name: r });

  // agents (canonicalized; pre-scan, one set)
  const agentNames = [...new Set([
    'unknown',
    ...items.flatMap((i) => [i.author, i.reporter, ...(i.notes || []).map((n) => n.by || n.author), ...(i.audit_trail || []).filter((a) => a.kind === 'transition').map((a) => a.detail?.by)].filter(Boolean).map(canonicalAgent)),
  ])].sort();
  for (const n of agentNames) addNode(`agent:${n}`, n, { kind: 'agent', name: n });

  // projects (one per distinct repo string; 'unknown' fallback) + components.
  // BUG-040 — content is NATURAL text (no kind prefix); skipDedupe:true on
  // writeGraph is what keeps distinct same-content nodes from collapsing
  // (previously the content was kind-prefixed to dodge the global content-hash
  // dedupe — proven live: project 'unknown' collapsed onto status 'UNKNOWN').
  const allRepos = [...new Set(items.map((i) => i.repo).filter(Boolean))].sort();
  if (items.some((i) => !i.repo)) allRepos.push('unknown');
  for (const r of allRepos) addNode(`project:${r}`, r, { kind: 'project', name: r });
  const compKeys = new Set();
  for (const it of items) compKeys.add(`${it.repo || 'unknown'}::${it.projectPath || 'unassigned'}`);
  for (const k of compKeys) {
    const name = k.split('::')[1];
    addNode(`component:${k}`, name, { kind: 'component', name });
    allEdges.push({ srcIdx: nodeIdx(`project:${k.split('::')[0]}`), dstIdx: nodeIdx(`component:${k}`), rel: 'owns_project' });
  }

  // issues + notes + citations + transitions
  let citationUnverifiable = 0, synthesized = 0;
  const repoRoot = '/Users/nix/dev/node/adhd';
  const issueNodeIds = [];

  for (const it of items) {
    const repo = it.repo || 'unknown';
    const itemKind = (it.kind || 'BUG').toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'BUG';
    const closedAt = (it.audit_trail || []).find((a) => a.kind === 'transition' && TERMINAL_STATUSES.has(a.detail?.to))?.at ?? null;
    const issueIdx = addNode(`issue:${it.repo}::${it.humanId}`, `${it.title || '(untitled)'}\n\n${it.body || ''}`, {
      kind: 'issue', name: it.title || '(untitled)',
      metadata: { title: it.title, body: it.body, kind: itemKind, status: it.status, priority: it.priority ?? null, created_at: it.createdAt, updated_at: it.updatedAt, closed_at: closedAt },
    });

    allEdges.push({ srcIdx: nodeIdx(`component:${repo}::${it.projectPath || 'unassigned'}`), dstIdx: issueIdx, rel: 'owns_component' });
    allEdges.push({ srcIdx: issueIdx, dstIdx: nodeIdx(`kind:${itemKind}`), rel: 'has_kind' });
    allEdges.push({ srcIdx: issueIdx, dstIdx: nodeIdx(`status:${it.status ?? 'OPEN'}`), rel: 'has_status' });
    if (it.priority) allEdges.push({ srcIdx: issueIdx, dstIdx: nodeIdx(`priority:${it.priority}`), rel: 'has_priority' });
    if (it.author) allEdges.push({ srcIdx: issueIdx, dstIdx: nodeIdx(`agent:${canonicalAgent(it.author)}`), rel: 'authored_by' });

    for (const n of it.notes || []) {
      const noteIdx = addNode(`note:${repo}::${it.humanId}:${n.at ?? allNodes.length}`, `${n.text || JSON.stringify(n)}`, { kind: 'note', metadata: { at: n.at ?? null } });
      allEdges.push({ srcIdx: issueIdx, dstIdx: noteIdx, rel: 'has_note' });
      allEdges.push({ srcIdx: noteIdx, dstIdx: nodeIdx(`agent:${canonicalAgent(n.by || n.author)}`), rel: 'authored_by' });
    }
    for (const c of it.citations || []) {
      const file = c.file || '';
      const contentSha = file ? shaFile(path.join(repoRoot, file)) : null;
      if (!contentSha) citationUnverifiable += 1;
      const citIdx = addNode(`citation:${repo}::${it.humanId}:${file}:${c.line ?? ''}`, `${file} sha:${contentSha || sha(file)}`, {
        kind: 'citation', metadata: { target: file, target_type: 'path', sha: contentSha || sha(file), sha_verified: contentSha ? 1 : 0, line: c.line ?? null },
      });
      allEdges.push({ srcIdx: issueIdx, dstIdx: citIdx, rel: 'has_citation' });
    }
    for (const a of it.audit_trail || []) {
      if (a.kind !== 'transition') continue;
      const d = a.detail || {};
      const hasNote = typeof d.note === 'string' && d.note.length > 0;
      const note = hasNote ? d.note : JSON.stringify(d);
      if (!hasNote) synthesized += 1;
      const trSha = sha(`${a.at ?? ''}\0${d.from ?? ''}\0${d.to ?? ''}\0${d.by ?? ''}\0${note}`);
      const trIdx = addNode(`transition:${repo}::${it.humanId}:${a.at ?? allNodes.length}`, `${d.from ?? ''} -> ${d.to ?? ''}${hasNote ? `: ${note}` : ''}`, {
        kind: 'transition', metadata: { from: d.from ?? null, to: d.to ?? null, note, note_synthesized: hasNote ? 0 : 1, sha: trSha, at: a.at ?? null },
      });
      allEdges.push({ srcIdx: issueIdx, dstIdx: trIdx, rel: 'has_transition' });
      allEdges.push({ srcIdx: trIdx, dstIdx: nodeIdx(`agent:${canonicalAgent(d.by)}`), rel: 'authored_by' });
    }
    issueNodeIds.push(issueIdx);
  }

  console.log(`[migrate-v2] writing ${allNodes.length} nodes + ${allEdges.length} edges in ONE batched writeGraph…`);
  // BUG-040 — skipDedupe: true. Identity is the DB-generated UUID, not the
  // content hash: 7 identical-title issues and 1339 transitions must each land
  // as a distinct UUID row, not collapse onto one content-hash duplicate. The
  // old kind-prefixed / `<!--v2:seq-->` content hacks are gone — content is
  // now natural text, and skipDedupe (opt-out) is what preserves distinctness.
  const writtenIds = await graph.writeGraph(allNodes, allEdges, { skipDedupe: true });
  const issueRealIds = issueNodeIds.map((i) => writtenIds[i]);
  console.log(`[migrate-v2] writeGraph done — ${writtenIds.length} nodes persisted`);
  if (process.env.MIGRATE_DEBUG) {
    for (const r of allRepos.slice(0, 4)) {
      const idx = nodeIndex.get(`project:${r}`);
      const id = writtenIds[idx];
      const rec = await graph.getNode(id);
      console.log(`  DEBUG project '${r}' -> writtenIds[${idx}]=${id} -> getNode: ${JSON.stringify(rec && { kind: rec.kind, name: rec.name, content: String(rec.content).slice(0, 30) })}`);
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings — same turso db, fastembed bge-base-en-v1.5, one vector/issue
  // (MIGRATE_SKIP_EMBED=1 skips this phase — fast debug iteration)
  // -------------------------------------------------------------------------
  let embedded = 0, embedFail = 0;
  let vectorStore = null, space = null;
  if (process.env.MIGRATE_SKIP_EMBED === '1') {
    console.log('[migrate-v2] MIGRATE_SKIP_EMBED=1 — skipping embeddings');
  } else {
  console.log('[migrate-v2] enabling embeddings (fastembed bge-base-en-v1.5 — first run downloads the model)…');
  const provider = await createEmbeddingProvider(EMBEDDING_MODEL);
  space = { modelId: provider.metadata.modelId, dim: provider.metadata.dimensions };
  vectorStore = await openTursoVectorStore(adapter, { dim: space.dim, modelId: space.modelId });
  await vectorStore.ensureSpace(space);
  const itemsList = items;
  for (let i = 0; i < issueNodeIds.length; i += 1) {
    const realId = issueRealIds[i];
    const it = itemsList[i];
    try {
      const vec = await provider.embedSingle(`${it.title || ''}\n${it.body || ''}`, 'document');
      await vectorStore.upsert(realId, vec, space);
      embedded += 1;
    } catch (e) { embedFail += 1; if (embedFail <= 3) console.error(`  embed fail: ${e.message}`); }
  }
  console.log(`[migrate-v2] embeddings: ${embedded} upserted, ${embedFail} failed (space ${space.modelId} dim ${space.dim})`);
  }

  // -------------------------------------------------------------------------
  // Verification (graph counts + traversal + a vector read)
  // -------------------------------------------------------------------------
  const issues = await graph.queryNodes({ kind: 'issue' });
  const projects = await graph.queryNodes({ kind: 'project' });
  const components = await graph.queryNodes({ kind: 'component' });
  const notes = await graph.queryNodes({ kind: 'note' });
  const citations = await graph.queryNodes({ kind: 'citation' });
  const transitions = await graph.queryNodes({ kind: 'transition' });
  const ownsEdges = await graph.getEdges({ rel: 'owns_component' });
  const sampleVec = vectorStore == null || issueRealIds[0] == null ? null : await vectorStore.get(issueRealIds[0], space.modelId);

  const proj0 = projects[0];
  let subgraph = null;
  if (proj0) subgraph = await graph.getSubgraph(proj0.id, { depth: 3, direction: 'out' });

  console.log('\n=== fresh v2 store (sox-graph-store + embeddings) ===');
  console.log(JSON.stringify({
    projects: projects.length, components: components.length, issues: issues.length,
    notes: notes.length, citations: citations.length, transitions: transitions.length,
    owns_component_edges: ownsEdges.length, embedded_vectors: embedded,
  }, null, 2));
  const closed = issues.filter((i) => i.metadata?.closed_at).length;
  console.log(`closed issues: ${closed}`);
  console.log(`source items: ${items.length} | v2 issues: ${issues.length}  ${issues.length === items.length ? 'MATCH ✓' : 'MISMATCH ✗'}`);
  console.log(`citations unverifiable (reference-addressed sha): ${citationUnverifiable}`);
  console.log(`transitions with synthesized notes: ${synthesized}`);
  console.log(`sample vector: ${sampleVec ? `Float32Array length ${sampleVec.length} (dim ${space.dim}) ${sampleVec.length === space.dim ? '✓' : '✗'}` : 'null (embedding read failed)'}`);
  if (subgraph) {
    const kinds = {};
    for (const n of subgraph.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
    console.log(`TRAVERSAL PROOF — getSubgraph(project '${proj0.name}', depth 3): ${JSON.stringify(kinds)} (edges: ${subgraph.edges.length})`);
  }
  const forkCandidates = [];
  for (const r of allRepos) {
    const norm = r.toLowerCase().replace(/^https?:\/\//, '').replace(/\.git$/, '').split('/').slice(-2).join('/');
    const others = allRepos.filter((x) => x !== r && x.toLowerCase().includes(norm.split('/').pop()));
    if (others.length) forkCandidates.push(`${r} ~ ${others.join(', ')}`);
  }
  if (forkCandidates.length) {
    console.log('\nFORK CANDIDATES (explicit reconcile decision required — not merged):');
    for (const f of forkCandidates) console.log('  ' + f);
  }
  console.log(`\n[migrate-v2] fresh file written: ${newDbPath} (old file untouched)`);
  await adapter.close();
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
