import { performance } from 'node:perf_hooks';
import { loadCorpus } from './corpus-loader.js';
import { openEtlStore } from './store-bootstrap.js';
import { scanResumeState } from './identity.js';
import { importItem } from './import-item.js';
import { normalizeProjectName, ADHD_PROJECT_NAME, ADHD_PROJECT_PATH } from './constants.js';
import { upsertProjectTx } from './catalog-upsert.js';
import { executeWriteTransaction, nowISO } from '../../src/write/tx.js';

async function main() {
  const extractDir = process.argv[2];
  const dbPath = process.argv[3];
  const n = Number(process.argv[4] ?? 100);
  const corpus = loadCorpus(extractDir);
  const handle = await openEtlStore(dbPath);
  await scanResumeState(handle.adapter);
  const items = corpus.items.slice(0, n);
  const distinctNames = new Set(items.map(i => normalizeProjectName(i.itemMeta.repo ?? i.namespace ?? 'global')));
  const projectsByName = new Map();
  for (const name of distinctNames) {
    const metadata = name === ADHD_PROJECT_NAME ? { path: ADHD_PROJECT_PATH } : {};
    const p = await executeWriteTransaction(handle, (tx) => upsertProjectTx(handle, tx, { name, metadata, at: nowISO() }));
    projectsByName.set(name, p);
  }
  const t0 = performance.now();
  for (const item of items) {
    const rawRepo = item.itemMeta.repo ?? item.namespace ?? 'global';
    const project = projectsByName.get(normalizeProjectName(rawRepo));
    const events = corpus.transitionEventsByItemRowid.get(item.rowid) ?? [];
    const t1 = performance.now();
    await importItem({ handle, item, rawRepo, project, transitionEvents: events, adhdProjectPath: project.name === ADHD_PROJECT_NAME ? ADHD_PROJECT_PATH : undefined });
    const t2 = performance.now();
    if (t2 - t1 > 200) console.error('SLOW item', item.rowid, (t2-t1).toFixed(1), 'ms citations=', (item.itemMeta.citations||[]).length, 'notes=', (item.itemMeta.notes||[]).length, 'transitions=', events.length);
  }
  const t3 = performance.now();
  console.error('TOTAL for', items.length, 'items:', (t3-t0).toFixed(1), 'ms => avg', ((t3-t0)/items.length).toFixed(2), 'ms/item');
  await handle.close();
}
main().catch(e => { console.error(e); process.exit(1); });
