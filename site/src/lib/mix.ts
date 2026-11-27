import type { Crash } from '../data';
import { hitGroup, impactGroup, movementGroup } from './responsibility';
import { cochranArmitage, twoProportionZ, wilson } from './stats';
import { TAG_LABEL } from '../theme';

// Incident mix over time: for one program and one field, the share of each category by half-year, with Wilson
// intervals, "among known" or "including unknown", and badges for the known reporting artifacts.

export type DimId = 'tag' | 'movement' | 'partner' | 'impact' | 'road' | 'light' | 'speed';
export type Dim = { id: DimId; label: string; multi: boolean; values: (c: Crash) => string[]; unknown: (c: Crash) => boolean };

const UNKNOWN = 'Unknown or not reported';
const ROAD: Record<string, string> = {
  intersection: 'Intersection', street: 'Street', highway: 'Highway or freeway', parking_lot: 'Parking lot', traffic_circle: 'Traffic circle', rural_road: 'Rural road',
};
const roadGroup = (r: string | null) => (r == null || r === 'unknown' ? UNKNOWN : ROAD[r] ?? 'Other road type');
const SPEED: Record<string, string> = { '0': '0 mph', '1-5': '1-5 mph', '6-15': '6-15 mph', '16-30': '16-30 mph', '31-50': '31-50 mph', '51+': '51+ mph' };

export const DIMS: Dim[] = [
  { id: 'tag', label: 'Failure-pattern tags (structured fields)', multi: true,
    values: (c) => c.tags.filter((t) => t.endsWith(':f')).map((t) => TAG_LABEL[t.split(':')[0]] ?? t.split(':')[0]), unknown: () => false },
  { id: 'movement', label: 'Pre-crash movement of the subject vehicle', multi: false,
    values: (c) => [c.sv_movement == null || c.sv_movement === 'unknown' ? UNKNOWN : c.sv_movement === 'other' ? 'Other movement' : movementGroup(c.sv_movement)],
    unknown: (c) => c.sv_movement == null || c.sv_movement === 'unknown' },
  { id: 'partner', label: 'Crash partner', multi: false, values: (c) => [hitGroup(c.crash_with)], unknown: (c) => hitGroup(c.crash_with) === 'Unknown or not reported' },
  { id: 'impact', label: 'Impact zone on the subject vehicle', multi: false, values: (c) => [impactGroup(c.sv_contact_areas ?? [])], unknown: (c) => impactGroup(c.sv_contact_areas ?? []) === 'Unknown or not reported' },
  { id: 'road', label: 'Road type', multi: false, values: (c) => [roadGroup(c.roadway_type)], unknown: (c) => roadGroup(c.roadway_type) === UNKNOWN },
  { id: 'light', label: 'Light condition (derived from time, approximate)', multi: false,
    values: (c) => [c.light_from_time === 'unknown' ? UNKNOWN : c.light_from_time[0].toUpperCase() + c.light_from_time.slice(1)], unknown: (c) => c.light_from_time === 'unknown' },
  { id: 'speed', label: 'Subject vehicle speed', multi: false, values: (c) => [SPEED[c.speed_band] ?? UNKNOWN], unknown: (c) => !(c.speed_band in SPEED) },
];
export const DIM_BY_ID = Object.fromEntries(DIMS.map((d) => [d.id, d])) as Record<DimId, Dim>;

export const halfOf = (month: string) => `${month.slice(0, 4)}H${Number(month.slice(5, 7)) <= 6 ? 1 : 2}`;
const BREAK_HALF = '2025H1'; // contains 2025-06-16
const isPre = (h: string) => h < BREAK_HALF;
const isPost = (h: string) => h > BREAK_HALF;

export type MixPoint = { period: string; k: number; n: number; share: number | null; lo: number | null; hi: number | null };
export type CategorySeries = { category: string; points: MixPoint[]; total: number; shift: Shift | null };
export type Shift = { pre: number; post: number; p: number; z: number; withinRegime: boolean; verdict: 'survives' | 'step-only' | 'none' };
export type MixResult = {
  periods: string[];
  categories: CategorySeries[];
  /** Share of crashes whose field is unknown, per half-year (in both modes). */
  unknown: MixPoint[];
  minN: number;
};

export const MIN_HALF_N = 20;
export const FOLD_BELOW = 0.03;
export const SHIFT_P = 0.001;

/**
 * Half-year mix for one program's crashes (dated). `knownOnly`: the denominator is the crashes whose field is known;
 * otherwise every crash. Categories below FOLD_BELOW of the program's known crashes fold into "Other (small categories)".
 * Half-years with fewer than `minN` crashes in the denominator carry no share.
 */
export function mixSeries(crashes: Crash[], dim: Dim, opts: { knownOnly: boolean; minN?: number }): MixResult {
  const minN = opts.minN ?? MIN_HALF_N;
  const dated = crashes.filter((c) => c.month);
  if (dated.length === 0) return { periods: [], categories: [], unknown: [], minN };
  const halves = [...new Set(dated.map((c) => halfOf(c.month!)))].sort();
  const periods: string[] = [];
  for (let y = Number(halves[0].slice(0, 4)), h = Number(halves[0].slice(5)); ; ) {
    const p = `${y}H${h}`;
    if (p > halves[halves.length - 1]) break;
    periods.push(p);
    if (h === 2) {
      y++;
      h = 1;
    } else h = 2;
  }
  const known = dated.filter((c) => !dim.unknown(c));
  const totals = new Map<string, number>();
  for (const c of known) for (const v of new Set(dim.values(c))) totals.set(v, (totals.get(v) ?? 0) + 1);
  const big = new Set([...totals.entries()].filter(([v, n]) => v !== UNKNOWN && n / Math.max(1, known.length) >= FOLD_BELOW).map(([v]) => v));
  const cat = (v: string) => (v === UNKNOWN ? null : big.has(v) ? v : 'Other (small categories)');
  const names = [...new Set([...totals.keys()].map(cat).filter((v): v is string => v != null))].sort((a, b) => {
    if (a.startsWith('Other')) return 1;
    if (b.startsWith('Other')) return -1;
    return (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
  });

  const byPeriod = new Map(periods.map((p) => [p, dated.filter((c) => halfOf(c.month!) === p)]));
  const denom = (p: string) => (opts.knownOnly ? byPeriod.get(p)!.filter((c) => !dim.unknown(c)) : byPeriod.get(p)!);
  const point = (p: string, k: number, n: number): MixPoint => {
    const w = n >= minN ? wilson(k, n) : null;
    return { period: p, k, n, share: w ? w[0] : null, lo: w ? w[1] : null, hi: w ? w[2] : null };
  };
  const categories: CategorySeries[] = names.map((name) => {
    const points = periods.map((p) => {
      const d = denom(p);
      const k = d.filter((c) => !dim.unknown(c) && dim.values(c).some((v) => cat(v) === name)).length;
      return point(p, k, d.length);
    });
    return { category: name, points, total: points.reduce((a, x) => a + x.k, 0), shift: shiftTest(points) };
  });
  const unknown = periods.map((p) => {
    const all = byPeriod.get(p)!;
    return point(p, all.filter((c) => dim.unknown(c)).length, all.length);
  });
  return { periods, categories, unknown, minN };
}

/**
 * Did a category's share change across the rule change, beyond chance and beyond the step? Pre (half-years before 2025H1)
 * vs post (after it) by a two-proportion z test at p < SHIFT_P; "survives" only when a Cochran-Armitage trend of the same
 * sign (p < 0.05) also exists inside at least one regime, else "step-only" (the step coincides with the threshold change).
 */
export function shiftTest(points: MixPoint[]): Shift | null {
  const sum = (ps: MixPoint[]) => ps.reduce((a, p) => [a[0] + p.k, a[1] + p.n], [0, 0]);
  const pre = points.filter((p) => isPre(p.period) && p.n > 0);
  const post = points.filter((p) => isPost(p.period) && p.n > 0);
  const [k1, n1] = sum(pre);
  const [k2, n2] = sum(post);
  const t = twoProportionZ(k1, n1, k2, n2);
  if (!t || n1 < 30 || n2 < 30) return null;
  const within = [pre, post].some((ps) => {
    if (ps.length < 3) return false;
    const ca = cochranArmitage(ps.map((p) => p.k), ps.map((p) => p.n));
    return !!ca && ca.p < 0.05 && Math.sign(ca.z) === Math.sign(t.z);
  });
  const sig = t.p < SHIFT_P;
  return { pre: k1 / n1, post: k2 / n2, p: t.p, z: t.z, withinRegime: within, verdict: !sig ? 'none' : within ? 'survives' : 'step-only' };
}

export type Artifact = { id: string; text: string; from: string };

/** Known reporting artifacts that touch a program's field, with the half-year they start in. */
export function artifactsFor(program: string, dim: DimId): Artifact[] {
  const out: Artifact[] = [
    { id: 'rule', from: '2025H1', text: 'Reporting threshold changed 2025-06-16: minor crashes left the data (mostly stationary, low-speed and rear contacts for driverless programs; tow-only crashes for Level 2), so shares step at the line.' },
  ];
  if (dim === 'tag') out.push({ id: 'lighting', from: '2025H2', text: 'The reduced-visibility tag reads the Lighting field, which is not collected after 2025-06-15, so that tag can only fire from weather after the change (drawn dashed after it).' });
  if (program === 'tesla_l2' && ['movement', 'partner', 'road', 'impact', 'tag'].includes(dim)) {
    out.push({ id: 'tesla-unknown', from: '2024H1', text: 'Tesla: from 2024 Q2 about 40% of reports have movement, partner and road type all Unknown, because Tesla stopped filing the follow-up versions that used to fill them in. Shares of all reports fall for that reason alone; use "among known" and read even that with care (which reports carry fields changed too).' });
  }
  if (dim === 'light') out.push({ id: 'light', from: '2021H2', text: 'Light condition is derived from the incident time and month with a one-hour twilight band (approximate), the same way in both regimes; Tesla times are converted from UTC.' });
  return out;
}
