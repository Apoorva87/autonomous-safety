import { useEffect, useState } from 'react';

export type Crash = {
  id: string;
  incident_key: string;
  /** How many programs filed a report of this incident (a multi-program incident is one record per program). */
  n_programs_in_incident: number;
  /** The program's own reports of this incident. */
  n_reports: number;
  era: string;
  entity: string;
  /** Every entity that filed a report of this incident under this program (usually just `entity`). */
  entities: string[];
  /** Driver / Operator Type of the program's report: none, remote, in_vehicle, in_vehicle_and_remote, consumer, other, unknown. */
  operator: string | null;
  company: string;
  program: string;
  month: string | null;
  lag_days: number | null;
  make: string | null;
  model: string | null;
  model_year: number | null;
  city: string | null;
  state: string | null;
  roadway_type: string | null;
  surface: string | null;
  lighting: string | null;
  weather: string[];
  speed_mph: number | null;
  speed_limit: number | null;
  speed_band: string;
  crash_with: string | null;
  cp_movement: string | null;
  sv_movement: string | null;
  severity: string;
  hospitalized: boolean | null;
  airbag: boolean | null;
  towed: boolean | null;
  within_odd: string | null;
  narrative_redacted: boolean;
  version_redacted: boolean;
  tags: string[]; // "name:f" (structured field) or "name:n" (narrative keyword)
};

export type Counts = {
  severities: string[];
  months: string[];
  programs: string[];
  counts: Record<string, Record<string, Record<string, number>>>;
};

export type Cell = { n: number; provided: number | null; unknown: number | null; redacted: number | null };
export type Transparency = {
  programs: string[];
  fields: string[];
  era_limited: Record<string, string>;
  cells: Record<string, Record<string, Cell>>;
};

export type FileInfo = {
  key: string;
  url: string;
  last_modified: string;
  retrieved_at: string;
  sha256: string;
  bytes: number;
  rows: number;
};
export type Meta = {
  source: string;
  run_date: string;
  fetched_date: string;
  nhtsa_last_modified: string;
  structural_break: string;
  total_reports: number;
  total_incidents: number;
  placeholder_rows_skipped: number;
  first_month: string | null;
  last_month: string | null;
  files: FileInfo[];
  tag_rules: { id: string; t: string; basis: string; description: string }[];
  run_id: string;
  run_at: string;
  rules_version: string;
  /** True when the published data came from a run that did not download the NHTSA files. */
  offline: boolean;
  offline_note: string | null;
  warnings: string[];
  counts_total: { reports: number; incidents: number; unique_incidents: number };
  disclosures: {
    company: string; program: string; metric: string; last_date: string; age_days: number; expected_every_days: number; stale: boolean;
  }[];
};

export type Data = { crashes: Crash[]; counts: Counts; transparency: Transparency; meta: Meta };

const base = import.meta.env.BASE_URL;

async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${base}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadData(): Promise<Data> {
  const [rec, counts, transparency, meta] = await Promise.all([
    getJson<{ fields: string[]; rows: unknown[][] }>('records.json'),
    getJson<Counts>('counts.json'),
    getJson<Transparency>('transparency.json'),
    getJson<Meta>('meta.json'),
  ]);
  const crashes = rec.rows.map((row) => {
    const o: Record<string, unknown> = {};
    rec.fields.forEach((f, i) => (o[f] = row[i]));
    return o as unknown as Crash;
  });
  return { crashes, counts, transparency, meta };
}

export function useData(): { data: Data | null; error: string | null } {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadData().then(setData, (e) => setError(String(e)));
  }, []);
  return { data, error };
}

export const fmt = (n: number) => n.toLocaleString('en-US');
export const pct = (x: number, digits = 0) => (x * 100).toFixed(digits) + '%';
export const humanize = (s: string | null | undefined) =>
  s == null ? 'not reported' : s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
