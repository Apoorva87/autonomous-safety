import { wilson } from './stats';

// Reporting completeness and revisions (revisions.json) and late filing by severity (lag.json histograms).

export type RevisionRow = {
  program: string;
  month: string;
  reports: number;
  revised: number;
  versions: number;
  first_unknown_revised: number[];
  latest_unknown_revised: number[];
  unknown_single: number[];
  unknown_latest: number[];
  all_unknown_latest: number;
  all_unknown_first_revised: number;
  all_unknown_latest_revised: number;
  gap_months: Record<string, number>;
};
export type RevisionsFile = { fields: string[]; all_unknown_fields: string[]; rows: RevisionRow[]; total_reports: number; notes: string[] };

export const FIELD_NAME: Record<string, string> = {
  sv_movement: 'Pre-crash movement', crash_with: 'Crash partner', cp_movement: 'Partner movement', sv_contact_areas: 'Contact area',
  roadway_type: 'Road type', speed_mph: 'Speed', severity: 'Injury severity',
};

export const quarterOf = (m: string) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;

export type RevisionPoint = {
  period: string;
  reports: number;
  revised: [number, number, number] | null;
  meanVersions: number | null;
  allUnknown: [number, number, number] | null;
};

/** Per program and period (quarter or year): revised share and all-unknown share (latest versions), with Wilson intervals. */
export function revisionSeries(rows: RevisionRow[], program: string, grain: 'quarter' | 'year'): RevisionPoint[] {
  const by = new Map<string, { reports: number; revised: number; versions: number; allUnknown: number }>();
  for (const r of rows) {
    if (r.program !== program || r.month === 'undated') continue;
    const p = grain === 'year' ? r.month.slice(0, 4) : quarterOf(r.month);
    const s = by.get(p) ?? { reports: 0, revised: 0, versions: 0, allUnknown: 0 };
    s.reports += r.reports;
    s.revised += r.revised;
    s.versions += r.versions;
    s.allUnknown += r.all_unknown_latest;
    by.set(p, s);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, s]) => ({
    period, reports: s.reports, revised: wilson(s.revised, s.reports), meanVersions: s.reports ? s.versions / s.reports : null, allUnknown: wilson(s.allUnknown, s.reports),
  }));
}

export type Dumbbell = { field: string; n: number; first: number; latest: number; single: number | null; singleN: number };

/** For a program's revised reports (optionally within months [from, to]): unknown share of each field in the first vs latest version. */
export function dumbbell(file: RevisionsFile, program: string, from = '', to = '9999'): Dumbbell[] {
  const rows = file.rows.filter((r) => r.program === program && r.month >= from && r.month <= to);
  const n = rows.reduce((a, r) => a + r.revised, 0);
  const singleN = rows.reduce((a, r) => a + r.reports - r.revised, 0);
  return file.fields.map((field, i) => ({
    field, n,
    first: n ? rows.reduce((a, r) => a + r.first_unknown_revised[i], 0) / n : 0,
    latest: n ? rows.reduce((a, r) => a + r.latest_unknown_revised[i], 0) / n : 0,
    single: singleN ? rows.reduce((a, r) => a + r.unknown_single[i], 0) / singleN : null,
    singleN,
  }));
}

/** Median months from first to latest version among revised reports (13 means 13 or more). */
export function medianGap(rows: RevisionRow[], program: string): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.program === program) for (const [k, v] of Object.entries(r.gap_months)) counts.set(Number(k), (counts.get(Number(k)) ?? 0) + v);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  let acc = 0;
  for (const k of [...counts.keys()].sort((a, b) => a - b)) {
    acc += counts.get(k)!;
    if (acc >= total / 2) return k;
  }
  return null;
}

export type LagHist = Partial<Record<'pre' | 'post', Record<string, number[]>>>;
export const SEVERITY_GROUPS = ['none', 'minor', 'moderate', 'serious', 'fatal', 'unknown'] as const;

/** Share of reports filed two or more months after the incident month ("more than a month late"), by severity, summed over programs. */
export function lateBySeverity(hists: LagHist[], regime: 'pre' | 'post'): { severity: string; n: number; late: [number, number, number] | null }[] {
  return SEVERITY_GROUPS.map((sev) => {
    let n = 0;
    let late = 0;
    for (const h of hists) {
      const bins = h[regime]?.[sev];
      if (!bins) continue;
      n += bins.reduce((a, b) => a + b, 0);
      late += bins.slice(2).reduce((a, b) => a + b, 0);
    }
    return { severity: sev, n, late: wilson(late, n) };
  });
}
