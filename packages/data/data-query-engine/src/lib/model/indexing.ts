/**
 * An index-accelerated store over a source's rows (§11–§13): equality (`PostingIndex`),
 * range (B+ tree), and low-cardinality (`RoaringBitmap`) indexes, maintained
 * incrementally on `add`/`remove`. `candidates(where)` narrows a predicate to a
 * row-id set using the indexes, or returns `undefined` when the predicate is not
 * indexable (the caller then falls back to a scan).
 *
 * The exact predicate is ALWAYS re-checked downstream, so an index only ever
 * accelerates — it can never change the result.
 */
import { BPlusTree, PostingIndex, RoaringBitmap } from '@adhd/data-core-structures';
import { compileAccessor, type PathGetter } from '../path';
import { fieldLeaves } from './phase';
import type { Predicate, Row, ScalarOperator } from './types';

export type IndexKind = 'eq' | 'range' | 'bitmap';
export interface IndexField {
  field: string;
  kind: IndexKind;
}

const accessors = new Map<string, PathGetter>();
function getPath(row: Row, field: string): unknown {
  let accessor = accessors.get(field);
  if (accessor === undefined) {
    accessor = compileAccessor(field);
    accessors.set(field, accessor);
  }
  return accessor(row);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

/** The index surface the planner needs; `IndexStore` structurally satisfies it. */
export interface PlannerIndex {
  /** A candidate id set for `predicate` via the indexes, or `undefined` if not indexable. */
  candidates(predicate: Predicate): Set<number> | undefined;
  /** Rows for a set of ids, in insertion order. */
  rowsFor(ids: Iterable<number>): Row[];
}

export class IndexStore implements PlannerIndex {
  private readonly rows = new Map<number, Row>();
  private readonly idsByKey = new Map<string, number[]>();
  private nextId = 0;
  private readonly eq = new Map<string, PostingIndex>();
  private readonly range = new Map<string, BPlusTree>();
  private readonly bitmap = new Map<string, Map<string, RoaringBitmap>>();
  /** Range fields that have held a present non-finite / non-number value. */
  private readonly rangeImpure = new Set<string>();

  constructor(fields: IndexField[]) {
    for (const f of fields) {
      if (f.kind === 'eq') this.eq.set(f.field, new PostingIndex());
      else if (f.kind === 'range') this.range.set(f.field, new BPlusTree());
      else this.bitmap.set(f.field, new Map());
    }
  }

  get size(): number {
    return this.rows.size;
  }

  add(row: Row): number {
    const id = this.nextId++;
    this.rows.set(id, row);
    const key = JSON.stringify(row);
    const bucket = this.idsByKey.get(key);
    if (bucket === undefined) this.idsByKey.set(key, [id]);
    else bucket.push(id);
    for (const [field, idx] of this.eq) idx.add(getPath(row, field), id);
    for (const [field, tree] of this.range) {
      const raw = getPath(row, field);
      // A present, non-null value that is not a finite number (a string, Date, NaN,
      // ±Infinity, …) is omitted from the numeric tree but may still MATCH a range
      // predicate, because `compareOrder` places NaN/Infinity among the numbers and
      // compares other types by string form. Mark the field impure so range narrowing
      // falls back to a scan — keeping the index a PURE SUPERSET (never a different
      // result). Null/undefined are safe: `isDefined` already excludes them.
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        this.rangeImpure.add(field);
        continue;
      }
      const v = num(raw);
      if (v === undefined) continue;
      const existing = tree.get(v);
      if (existing === undefined) tree.insert(v, [id]);
      else (existing as number[]).push(id);
    }
    for (const [field, byValue] of this.bitmap) {
      const k = JSON.stringify(getPath(row, field));
      let bm = byValue.get(k);
      if (bm === undefined) {
        bm = new RoaringBitmap();
        byValue.set(k, bm);
      }
      bm.add(id);
    }
    return id;
  }

  remove(row: Row): boolean {
    const key = JSON.stringify(row);
    const bucket = this.idsByKey.get(key);
    if (bucket === undefined || bucket.length === 0) return false;
    const id = bucket.shift();
    if (id === undefined) return false;
    if (bucket.length === 0) this.idsByKey.delete(key);
    this.rows.delete(id);
    for (const [field, idx] of this.eq) idx.remove(getPath(row, field), id);
    for (const [field, tree] of this.range) {
      const raw = getPath(row, field);
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        this.rangeImpure.add(field);
        continue;
      }
      const v = num(raw);
      if (v === undefined) continue;
      const existing = tree.get(v) as number[] | undefined;
      if (existing !== undefined) {
        const i = existing.indexOf(id);
        if (i >= 0) existing.splice(i, 1);
      }
    }
    for (const [field, byValue] of this.bitmap) {
      const bm = byValue.get(JSON.stringify(getPath(row, field)));
      if (bm !== undefined) bm.remove(id);
    }
    return true;
  }

  /** Rows for a set of ids, in insertion order. */
  rowsFor(ids: Iterable<number>): Row[] {
    const out: Row[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const row = this.rows.get(id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  allRows(): Row[] {
    return this.rowsFor(this.rows.keys());
  }

  /** A candidate id set for `where` via the indexes, or `undefined` if not indexable. */
  candidates(node: Predicate): Set<number> | undefined {
    let result: Set<number> | undefined;
    const merge = (ids: Set<number> | undefined): void => {
      if (ids === undefined) return;
      result = result === undefined ? ids : intersect(result, ids);
    };
    for (const c of node._and ?? []) merge(this.candidates(c));
    if (node._or !== undefined) {
      if (node._or.length === 0) return undefined;
      let union: Set<number> | undefined;
      for (const c of node._or) {
        const ids = this.candidates(c);
        if (ids === undefined) return undefined; // an un-indexable disjunct → cannot narrow
        if (union === undefined) union = new Set(ids);
        else for (const id of ids) union.add(id);
      }
      merge(union);
    }
    // A `_not` conjunct cannot narrow on its own, but it must NOT discard the
    // narrower conjuncts already found (`X AND NOT Y` is still ⊆ X).
    for (const [field, operator] of fieldLeaves(node)) merge(this.leafIds(field, operator));
    return result;
  }

  private leafIds(field: string, operator: ScalarOperator): Set<number> | undefined {
    let result: Set<number> | undefined;
    for (const [op, operand] of Object.entries(operator)) {
      const ids = this.opIds(field, op, operand);
      if (ids === undefined) continue;
      result = result === undefined ? ids : intersect(result, ids);
    }
    return result;
  }

  private opIds(field: string, op: string, operand: unknown): Set<number> | undefined {
    const eqIdx = this.eq.get(field);
    const bitIdx = this.bitmap.get(field);
    const rangeIdx = this.range.get(field);
    if (op === '_eq' && (eqIdx !== undefined || bitIdx !== undefined)) {
      if (eqIdx !== undefined) return new Set(eqIdx.get(operand));
      const bm = bitIdx?.get(JSON.stringify(operand));
      return bm === undefined ? new Set() : new Set(bm.toArray());
    }
    if (op === '_in' && Array.isArray(operand) && (eqIdx !== undefined || bitIdx !== undefined)) {
      const out = new Set<number>();
      for (const v of operand) {
        const ids = eqIdx !== undefined ? eqIdx.get(v) : bitIdx?.get(JSON.stringify(v))?.toArray() ?? [];
        for (const id of ids) out.add(id);
      }
      return out;
    }
    if (rangeIdx === undefined || this.rangeImpure.has(field)) return undefined;
    if (op === '_between' && Array.isArray(operand) && operand.length >= 2) {
      const lo = num(operand[0]);
      const hi = num(operand[1]);
      if (lo === undefined || hi === undefined) return undefined;
      return this.rangeIds(rangeIdx, lo, hi, false, false);
    }
    const v = num(operand);
    if (v === undefined) return undefined;
    if (op === '_gt') return this.rangeIds(rangeIdx, v, Infinity, true, false);
    if (op === '_gte') return this.rangeIds(rangeIdx, v, Infinity, false, false);
    if (op === '_lt') return this.rangeIds(rangeIdx, -Infinity, v, false, true);
    if (op === '_lte') return this.rangeIds(rangeIdx, -Infinity, v, false, false);
    return undefined;
  }

  private rangeIds(tree: BPlusTree, lo: number, hi: number, loExclusive: boolean, hiExclusive: boolean): Set<number> {
    const out = new Set<number>();
    for (const [k, ids] of tree.range(lo, hi)) {
      if (loExclusive && k <= lo) continue;
      if (hiExclusive && k >= hi) continue;
      for (const id of ids as number[]) out.add(id);
    }
    return out;
  }
}
