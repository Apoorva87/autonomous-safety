import type { Confidence, Label, RespRow } from './responsibility';
import { wilson } from './stats';

// Crash-level responsibility (one row per program and incident, from the pipeline's roll-up) and the
// missingness-guarded view over time.

export type OwnKind = 'fixed_object' | 'animal' | 'road_user' | 'other';
export const OWN_KIND_NAME: Record<OwnKind, string> = {
  fixed_object: 'Single vehicle: fixed object, pole or tree',
  animal: 'Animal',
  road_user: 'Struck another road user',
  other: 'Other or unknown partner',
};
export const OWN_KINDS: OwnKind[] = ['fixed_object', 'animal', 'road_user', 'other'];

export type CrashLabel = {
  program: string;
  incident_key: string;
  month: string | null;
  label: Label;
  confidence: Confidence;
  /** Rule of the representative report (the program's highest-severity report). */
  rule: string;
  ownKind: OwnKind | null;
  reports: number;
  severity: string;
};

type RowWithRollup = RespRow & { crash_rep?: boolean; crash_label?: Label; crash_own_kind?: OwnKind | null; own_kind?: OwnKind | null };

/**
 * One crash per (program, incident). The label is the pipeline roll-up (crash_label); the confidence is that of the
 * lowest-id report carrying that label, or low for cannot tell. Rows without the roll-up fields (older files) fall back
 * to one crash per report.
 */
export function crashLabels(rows: RespRow[]): CrashLabel[] {
  const groups = new Map<string, RowWithRollup[]>();
  for (const r of rows as RowWithRollup[]) {
    const k = `${r.program}|${r.incident_key}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: CrashLabel[] = [];
  for (const members of groups.values()) {
    const rep = members.find((m) => m.crash_rep) ?? members[0];
    const label = rep.crash_label ?? rep.label;
    const carrier = [...members].sort((a, b) => a.report_id.localeCompare(b.report_id)).find((m) => m.label === label);
    out.push({
      program: rep.program, incident_key: rep.incident_key, month: rep.month, label,
      confidence: label === 'indeterminate' ? 'low' : carrier?.confidence ?? 'medium',
      rule: rep.rule, ownKind: label === 'subject_vehicle_initiated' ? rep.crash_own_kind ?? carrier?.own_kind ?? 'other' : null,
      reports: members.length, severity: rep.severity,
    });
  }
  return out;
}

export const halfOf = (month: string) => `${month.slice(0, 4)}H${Number(month.slice(5, 7)) <= 6 ? 1 : 2}`;

export type HalfPoint = {
  period: string;
  /** Crashes in the half-year. */
  n: number;
  labelled: number;
  own: number;
  other: number;
  indeterminate: number;
  /** Cannot tell because the movement or contact area is missing (RESP-IND-1). */
  missing: number;
  missingShare: number | null;
  /** Own motion among labelled crashes, with Wilson 95% interval; null when suppressed. */
  ownShare: [number, number, number] | null;
  /** Range of the own-motion share over all crashes if every cannot-tell crash were other party (lo) or own motion (hi). */
  envelope: [number, number] | null;
  suppressed: boolean;
  /** The missing share moved more than BREAK_POINTS from the previous half-year: not comparable with it. */
  comparabilityBreak: boolean;
};

export const MIN_LABELLED = 30;
export const BREAK_POINTS = 0.1;

/** Half-year series for one program's crashes. Half-years between the first and last present are filled. */
export function byHalfYear(crashes: CrashLabel[], minLabelled = MIN_LABELLED): HalfPoint[] {
  const dated = crashes.filter((c) => c.month);
  if (dated.length === 0) return [];
  const halves = dated.map((c) => halfOf(c.month!)).sort();
  const periods: string[] = [];
  let y = Number(halves[0].slice(0, 4));
  let h = Number(halves[0].slice(5));
  while (`${y}H${h}` <= halves[halves.length - 1]) {
    periods.push(`${y}H${h}`);
    if (h === 2) {
      y++;
      h = 1;
    } else h = 2;
  }
  const out: HalfPoint[] = [];
  for (const period of periods) {
    const cs = dated.filter((c) => halfOf(c.month!) === period);
    const n = cs.length;
    const own = cs.filter((c) => c.label === 'subject_vehicle_initiated').length;
    const other = cs.filter((c) => c.label === 'other_party').length;
    const ind = n - own - other;
    const missing = cs.filter((c) => c.label === 'indeterminate' && c.rule === 'RESP-IND-1').length;
    const labelled = own + other;
    const suppressed = labelled < minLabelled;
    const prev = out[out.length - 1];
    const missingShare = n ? missing / n : null;
    out.push({
      period, n, labelled, own, other, indeterminate: ind, missing, missingShare,
      ownShare: suppressed ? null : wilson(own, labelled),
      envelope: n ? [own / n, (own + ind) / n] : null,
      suppressed,
      comparabilityBreak: !!prev && prev.missingShare != null && missingShare != null && prev.n > 0 && Math.abs(missingShare - prev.missingShare) > BREAK_POINTS,
    });
  }
  return out;
}

/** Own-motion sub-kind counts for one program's crashes. */
export function ownKindCounts(crashes: CrashLabel[]): Record<OwnKind, number> {
  const out: Record<OwnKind, number> = { fixed_object: 0, animal: 0, road_user: 0, other: 0 };
  for (const c of crashes) if (c.ownKind) out[c.ownKind]++;
  return out;
}
