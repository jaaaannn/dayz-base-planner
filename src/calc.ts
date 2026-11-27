import {
  FUEL_PER_BOTTLE, NAILS_PER_SCRAP, PLANKS_PER_LOG_HAND, PLANKS_PER_LOG_SAW, SCRAP_PER_SHEET, WORKBENCH_BATCH,
} from './constants';
import { MATERIALS, PARTS, UPKEEP_CATS, type MatId, type ToolId, type UpkeepCat } from './data';
import type { Piece } from './store';

export type MatTotals = Map<MatId, number>;

type FlatRecipe = ReadonlyArray<readonly [MatId, number]>;

const hasOwn = Object.prototype.hasOwnProperty;
const numberFormatter = new Intl.NumberFormat('de-DE');
const nameCollator = new Intl.Collator('de-DE');

const recipeCache = new Map<string, FlatRecipe>();
const subPartsCache = new Map<string, readonly string[]>();

function getPart(id: string) {
  return hasOwn.call(PARTS, id) ? PARTS[id] : undefined;
}

function getSubParts(partId: string): readonly string[] {
  const cached = subPartsCache.get(partId);
  if (cached) return cached;

  const r = getPart(partId)?.recipe;
  const subs = r ? Object.keys(r).filter((k) => getPart(k) !== undefined) : [];
  subPartsCache.set(partId, subs);
  return subs;
}

function getFlatRecipe(partId: string, active = new Set<string>()): FlatRecipe {
  const cached = recipeCache.get(partId);
  if (cached) return cached;

  const r = getPart(partId)?.recipe;
  if (!r) return [];

  if (active.has(partId)) return [];
  active.add(partId);

  const totals = new Map<MatId, number>();
  let cycleDetected = false;

  for (const [k, n] of Object.entries(r)) {
    if (getPart(k)) {
      if (active.has(k)) {
        cycleDetected = true;
        continue;
      }
      for (const [mat, subQty] of getFlatRecipe(k, active)) {
        totals.set(mat, (totals.get(mat) ?? 0) + subQty * n);
      }
    } else {
      totals.set(k as MatId, (totals.get(k as MatId) ?? 0) + n);
    }
  }

  active.delete(partId);

  const flat: FlatRecipe = [...totals.entries()];
  if (!cycleDetected) recipeCache.set(partId, flat);
  return flat;
}

export function countByType(pieces: Piece[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of pieces) m.set(p.t, (m.get(p.t) ?? 0) + 1);
  return m;
}

export function materialsFor(pieces: Piece[]): MatTotals {
  const out: MatTotals = new Map();
  for (const [t, count] of countByType(pieces)) {
    for (const [mat, qty] of getFlatRecipe(t)) {
      out.set(mat, (out.get(mat) ?? 0) + qty * count);
    }
  }
  return sortMats(out);
}

export function sortMats(m: MatTotals): MatTotals {
  if (m.size <= 1) return new Map(m);
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

export interface RawOptions {
  nailsFromScrap: boolean;
  sheetFromScrap: boolean;
  planksFromLogs: false | 'hand' | 'saw';
}

/** Resolve nails, sheet metal and planks down to scrap and logs, as the wiki's conversions allow. */
export function toRaw(m: MatTotals, o: RawOptions): MatTotals {
  const out: MatTotals = new Map(m);

  if (o.nailsFromScrap) {
    const nails = out.get('nails');
    if (nails !== undefined) {
      out.delete('nails');
      if (nails > 0) out.set('scrap', (out.get('scrap') ?? 0) + Math.ceil(nails / NAILS_PER_SCRAP));
    }
  }

  if (o.sheetFromScrap) {
    const sheet = out.get('sheet');
    if (sheet !== undefined) {
      out.delete('sheet');
      if (sheet > 0) out.set('scrap', (out.get('scrap') ?? 0) + sheet * SCRAP_PER_SHEET);
    }
  }

  if (o.planksFromLogs) {
    const planks = out.get('planks');
    if (planks !== undefined) {
      out.delete('planks');
      if (planks > 0) {
        const perLog = o.planksFromLogs === 'saw' ? PLANKS_PER_LOG_SAW : PLANKS_PER_LOG_HAND;
        out.set('logs', (out.get('logs') ?? 0) + Math.ceil(planks / perLog));
      }
    }
  }

  return sortMats(out);
}

export function toolsFor(pieces: Piece[]): Map<ToolId, string[]> {
  const seenTools = new Map<ToolId, Set<string>>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);

    const d = getPart(id);
    if (!d) return;

    for (const tool of d.tools) {
      let names = seenTools.get(tool);
      if (!names) {
        names = new Set<string>();
        seenTools.set(tool, names);
      }
      names.add(d.name);
    }
    for (const sub of getSubParts(id)) visit(sub);
  };

  for (const p of pieces) visit(p.t);

  const out = new Map<ToolId, string[]>();
  for (const [tool, names] of seenTools) out.set(tool, [...names]);
  return out;
}

export function craftClicks(pieces: Piece[]): number {
  let n = 0;
  for (const [t, c] of countByType(pieces)) {
    const d = getPart(t);
    if (!d?.recipe || d.handCraft) continue;
    n += Math.ceil(c / WORKBENCH_BATCH) * (1 + getSubParts(t).length);
  }
  return n;
}

export function unknownCostParts(pieces: Piece[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [t, n] of countByType(pieces)) {
    if (!getPart(t)?.recipe) out.set(t, n);
  }
  return out;
}

export function matName(id: MatId) {
  return (hasOwn.call(MATERIALS, id) ? MATERIALS[id]?.name : undefined) ?? id;
}

// ------------------------------------------------------------------- upkeep
export function upkeepCounts(pieces: Piece[]): Map<UpkeepCat, number> {
  const m = new Map<UpkeepCat, number>();
  for (const c of UPKEEP_CATS) m.set(c.id, 0);
  for (const p of pieces) {
    const d = getPart(p.t);
    if (!d) continue;
    const c = d.upkeep;
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
}

// --------------------------------------------------------------------- raid
export interface RaidRow {
  id: string;
  name: string;
  count: number;
  charges: number;
  fuel: number;
  assumed: boolean;
}

export function raidRows(pieces: Piece[]): RaidRow[] {
  const rows: RaidRow[] = [];
  for (const [t, n] of countByType(pieces)) {
    const d = getPart(t);
    if (!d?.raid) continue;
    rows.push({
      id: t,
      name: d.name,
      count: n,
      charges: d.raid.charges,
      fuel: d.raid.fuel,
      assumed: Boolean(d.raid.chargesAssumed || d.raid.fuelAssumed),
    });
  }
  return rows.sort((a, b) => a.fuel - b.fuel || nameCollator.compare(a.name, b.name));
}

export function raidTotals(rows: RaidRow[]) {
  let charges = 0;
  let fuel = 0;
  for (const r of rows) {
    charges += r.charges * r.count;
    fuel += r.fuel * r.count;
  }
  const bottles = fuel / FUEL_PER_BOTTLE;
  return { charges, fuel, bottles, soloMinutes: bottles * 10 };
}

export const fmt = (n: number) => numberFormatter.format(n);
