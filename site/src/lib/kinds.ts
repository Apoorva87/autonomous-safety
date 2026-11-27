// Kind groups. SGO reporting thresholds differ between Level 2 driver assistance and driverless (ADS) programs:
// an L2 crash is reportable only when it meets severity, vulnerable-road-user, airbag or tow-away criteria, while
// an ADS crash is reportable at almost any contact. Their crash counts and rates are therefore never put on one axis,
// one funnel, one ranking or one overlaid line.

export type KindId = 'ads' | 'l2';

export const KIND_GROUPS: { id: KindId; label: string; short: string; programs: string[] }[] = [
  { id: 'ads', label: 'Driverless (ADS)', short: 'ADS', programs: ['waymo_ads', 'gm_cruise_ads', 'zoox_ads', 'tesla_robotaxi', 'other_ads'] },
  { id: 'l2', label: 'Driver assistance (Level 2)', short: 'L2', programs: ['tesla_l2', 'gm_supercruise', 'other_l2'] },
];

const KIND_BY_PROGRAM: Record<string, KindId> = Object.fromEntries(KIND_GROUPS.flatMap((g) => g.programs.map((p) => [p, g.id])));

export const kindOf = (program: string): KindId | null => KIND_BY_PROGRAM[program] ?? null;
export const kindLabel = (k: KindId) => KIND_GROUPS.find((g) => g.id === k)!.label;

/** The caveat shown wherever both kinds can appear on one page. */
export const KIND_CAVEAT =
  'Level 2 and ADS programs have different NHTSA reporting thresholds; their crash counts and rates are not comparable.';

/** True when the programs belong to more than one kind group. Unknown programs are ignored. */
export function mixesKinds(programs: string[]): boolean {
  return new Set(programs.map(kindOf).filter((k): k is KindId => k != null)).size > 1;
}

/** Keep only the programs of one kind: `keep`, else the kind of the first program that has one. Order is preserved. */
export function limitToKind(programs: string[], keep?: KindId | null): string[] {
  const kind = keep ?? programs.map(kindOf).find((k) => k != null) ?? null;
  return kind == null ? programs : programs.filter((p) => kindOf(p) === kind);
}

/** Toggle a program in a selection that may hold one kind only: picking a program of the other kind starts a new selection. */
export function toggleWithinKind(picked: string[], program: string): string[] {
  if (picked.includes(program)) return picked.filter((p) => p !== program);
  const kind = kindOf(program);
  return [...picked.filter((p) => kindOf(p) === kind), program];
}

/** Split items into kind groups (items whose program has no kind are dropped). Never merges the groups. */
export function splitByKind<T>(items: T[], program: (t: T) => string): Record<KindId, T[]> {
  const out: Record<KindId, T[]> = { ads: [], l2: [] };
  for (const it of items) {
    const k = kindOf(program(it));
    if (k) out[k].push(it);
  }
  return out;
}

/**
 * Funnel and ranking guard: a pooled reference is only meaningful inside one kind group, so mixed input keeps the kind of
 * the first item and drops the rest.
 */
export function singleKindItems<T extends { kind: KindId | null }>(items: T[]): T[] {
  const first = items.find((i) => i.kind != null)?.kind ?? null;
  return first == null ? items : items.filter((i) => i.kind === first);
}
