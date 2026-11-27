import type { Crash } from '../data';
import { PROGRAMS } from '../theme';
import { ZONES, type Zone, type WithContact } from './impact';
import { csvCell } from './format';

// Responsibility lens (rules v2). An inference from structured report fields, never a finding of fault.
// One label per current report, about that report's own vehicle. Counts are per report-label; programs overlap for
// multi-program incidents, so counts are never summed across programs.

export type Label = 'other_party' | 'subject_vehicle_initiated' | 'indeterminate';
export type Confidence = 'high' | 'medium' | 'low';
export const LABELS: Label[] = ['other_party', 'subject_vehicle_initiated', 'indeterminate'];
export const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
export const CONFIDENCE_NAME: Record<Confidence, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export type RespFile = {
  disclaimer: string;
  fields: string[];
  label_set: string;
  rules_version: string;
  rows: (string | null)[][];
};
export type RespRow = {
  report_id: string;
  report_key: string;
  incident_key: string;
  program: string;
  month: string | null;
  label: Label;
  confidence: Confidence;
  basis: 'field' | 'narrative';
  rule: string;
  agent_hint: string | null;
};
export type Rule = { id: string; label: Label; confidence: Confidence; description: string };
export type RetiredRule = Rule & { reason: string; retired_in: string };
export type RulesFile = {
  agent_hints: Record<string, string>;
  disclaimer: string;
  retired_rules: RetiredRule[];
  rules: Rule[];
  rules_version: string;
};
export type AuditComparison = {
  agree: number;
  disagree: number;
  agreement_rate: number | null;
  readable_narratives: number;
  confusion: Record<string, Record<string, number>>;
};
export type AuditExample = { cue: string; label: Label; program: string; reason: string; report_id: string; report_key: string; rule: string };
export type AuditFile = {
  comparison: Record<string, AuditComparison>;
  cues: Record<string, string[]>;
  disagreement_examples: AuditExample[];
  disclaimer: string;
  rules_version: string;
};

export function parseRows(file: RespFile): RespRow[] {
  const idx = Object.fromEntries(file.fields.map((f, i) => [f, i]));
  return file.rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const f of file.fields) o[f] = r[idx[f]];
    return o as unknown as RespRow;
  });
}

// ---------- program kind and display names ----------

export const L2_PROGRAMS = ['tesla_l2', 'gm_supercruise', 'other_l2'];
export const isL2 = (program: string) => L2_PROGRAMS.includes(program);

export const OWN_L2 = 'Own motion (driver or system; NHTSA data cannot separate them)';
export const OWN_ADS = 'Own motion (automated driving system)';
export const OTHER_NAME = 'Other party involved/initiated';
export const CANNOT_NAME = 'Cannot tell';

/** The wording shown for a label. Own motion is worded by program kind; with no program it is the bare "Own motion". */
export function labelName(label: Label, program?: string): string {
  if (label === 'other_party') return OTHER_NAME;
  if (label === 'indeterminate') return CANNOT_NAME;
  if (program == null) return 'Own motion';
  return isL2(program) ? OWN_L2 : OWN_ADS;
}

export const BANNER = (rulesVersion: string) =>
  `Inferred, not a finding of fault. NHTSA records no fault. Labels come from transparent rules on structured report fields (rules v${rulesVersion}); read the rules and the audit below.`;

// ---------- joining to records ----------

export type JoinedRow = RespRow & {
  /** Highest injury severity of the incident (the record the site already shows). */
  severity: string;
  /** The report's own record, when it is the incident's primary report in records.json; otherwise null. */
  rec: WithContact | null;
};

/** Join labels to records. Structured fields only exist for each incident's primary report; severity is per incident. */
export function joinRows(rows: RespRow[], crashes: Crash[]): JoinedRow[] {
  const byId = new Map<string, WithContact>();
  const byInc = new Map<string, WithContact>();
  for (const c of crashes as WithContact[]) {
    byId.set(c.id, c);
    byInc.set(c.incident_key, c);
  }
  return rows.map((r) => ({ ...r, rec: byId.get(r.report_id) ?? null, severity: (byId.get(r.report_id) ?? byInc.get(r.incident_key))?.severity ?? 'unknown' }));
}

// ---------- filters ----------

export type RespFilters = {
  programs: string[];
  severities: string[];
  from: string;
  to: string;
  /** List-only filters (do not change the bars, flow or time charts). */
  label: string;
  rule: string;
  /** "nodeId" or "sourceId|targetId" from the flow diagram. */
  flow: string;
};
export const NO_LIST_FILTERS = { label: '', rule: '', flow: '' };

const anyOf = (sel: string[], v: string | null | undefined) => sel.length === 0 || (v != null && sel.includes(v));

/** Controls shared by every panel: program, severity, month range. */
export function applyControls(rows: JoinedRow[], f: Pick<RespFilters, 'programs' | 'severities' | 'from' | 'to'>): JoinedRow[] {
  return rows.filter(
    (r) =>
      anyOf(f.programs, r.program) &&
      anyOf(f.severities, r.severity) &&
      (!f.from || (r.month ?? '') >= f.from) &&
      (!f.to || (r.month ?? '9999') <= f.to),
  );
}

/** Controls plus the list-only filters (label, rule, flow selection). */
export function applyFilters(rows: JoinedRow[], f: RespFilters): JoinedRow[] {
  const base = applyControls(rows, f);
  const flow = f.flow ? f.flow.split('|') : [];
  return base.filter((r) => {
    if (f.label && labelKey(r) !== f.label && r.label !== f.label) return false;
    if (f.rule && r.rule !== f.rule) return false;
    if (flow.length) {
      const p = pathOf(r);
      if (!p) return false;
      if (flow.length === 1 && !p.includes(flow[0])) return false;
      if (flow.length === 2) {
        const i = p.indexOf(flow[0]);
        if (i < 0 || p[i + 1] !== flow[1]) return false;
      }
    }
    return true;
  });
}

// ---------- aggregation by program ----------

export type ProgramAgg = {
  program: string;
  total: number;
  /** counts[label][confidence] */
  counts: Record<Label, Record<Confidence, number>>;
  labelTotal: Record<Label, number>;
  /** Share of the program's reports (0..1) per label. */
  share: Record<Label, number>;
};

const emptyCounts = (): Record<Label, Record<Confidence, number>> => ({
  other_party: { high: 0, medium: 0, low: 0 },
  subject_vehicle_initiated: { high: 0, medium: 0, low: 0 },
  indeterminate: { high: 0, medium: 0, low: 0 },
});

/** Counts and shares per program, in the site's program order. Programs are never summed together. */
export function aggregateByProgram(rows: JoinedRow[]): ProgramAgg[] {
  const m = new Map<string, ProgramAgg>();
  for (const r of rows) {
    let a = m.get(r.program);
    if (!a) {
      a = { program: r.program, total: 0, counts: emptyCounts(), labelTotal: { other_party: 0, subject_vehicle_initiated: 0, indeterminate: 0 }, share: { other_party: 0, subject_vehicle_initiated: 0, indeterminate: 0 } };
      m.set(r.program, a);
    }
    a.total++;
    a.counts[r.label][r.confidence]++;
    a.labelTotal[r.label]++;
  }
  for (const a of m.values()) for (const l of LABELS) a.share[l] = a.total ? a.labelTotal[l] / a.total : 0;
  const order = PROGRAMS.map((p) => p.key);
  return [...m.values()].sort((a, b) => order.indexOf(a.program) - order.indexOf(b.program));
}

/** Incidents that appear under more than one program in `rows` (why per-program counts overlap). */
export function multiProgramIncidents(rows: Pick<RespRow, 'incident_key' | 'program'>[]): number {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = m.get(r.incident_key) ?? new Set<string>();
    s.add(r.program);
    m.set(r.incident_key, s);
  }
  let n = 0;
  for (const s of m.values()) if (s.size > 1) n++;
  return n;
}

// ---------- over time ----------

export type Grain = 'month' | 'year';
export const periodOf = (month: string, grain: Grain) => (grain === 'year' ? month.slice(0, 4) : month);

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** Every period between the first and last month present (gaps filled), so an empty month is a visible gap. */
export function periodRange(months: string[], grain: Grain): string[] {
  const ms = months.filter(Boolean).sort();
  if (ms.length === 0) return [];
  const out: string[] = [];
  if (grain === 'year') {
    for (let y = Number(ms[0].slice(0, 4)); y <= Number(ms[ms.length - 1].slice(0, 4)); y++) out.push(String(y));
    return out;
  }
  for (let m = ms[0]; m <= ms[ms.length - 1]; m = nextMonth(m)) out.push(m);
  return out;
}

export type TimeSeries = { periods: string[]; counts: Record<Label, number[]>; totals: number[] };

/** Label counts per period for one program's rows. Rows with no month are left out. */
export function timeSeries(rows: JoinedRow[], periods: string[], grain: Grain): TimeSeries {
  const at = new Map(periods.map((p, i) => [p, i]));
  const counts: Record<Label, number[]> = { other_party: periods.map(() => 0), subject_vehicle_initiated: periods.map(() => 0), indeterminate: periods.map(() => 0) };
  const totals = periods.map(() => 0);
  for (const r of rows) {
    if (!r.month) continue;
    const i = at.get(periodOf(r.month, grain));
    if (i == null) continue;
    counts[r.label][i]++;
    totals[i]++;
  }
  return { periods, counts, totals };
}

/** Share of a period's reports per label, or null where the period has fewer than `minN` reports (too few to read as a share). */
export function periodShare(ts: TimeSeries, label: Label, minN: number): (number | null)[] {
  return ts.totals.map((n, i) => (n >= minN ? ts.counts[label][i] / n : null));
}

// ---------- flow diagram (sankey) ----------

const FRONT: Zone[] = ['front', 'front_left', 'front_right'];
const REAR: Zone[] = ['rear', 'rear_left', 'rear_right'];
const SIDE: Zone[] = ['left', 'right'];

export const MOVE_GROUPS: Record<string, string> = {
  stopped: 'Stopped or parked', parked: 'Stopped or parked',
  proceeding_straight: 'Going straight',
  lane_departure: 'Lane departure',
  left_turn: 'Turning or changing lanes', right_turn: 'Turning or changing lanes', changing_lanes: 'Turning or changing lanes',
  merging: 'Turning or changing lanes', passing: 'Turning or changing lanes', u_turn: 'Turning or changing lanes',
  entering_traffic: 'Turning or changing lanes', crossing_opposing_lane: 'Turning or changing lanes', wrong_way: 'Turning or changing lanes',
  backing: 'Backing or parking', parking_maneuver: 'Backing or parking',
};
export const movementGroup = (m: string | null | undefined) => (m ? MOVE_GROUPS[m] ?? 'Unknown or other' : 'Unknown or other');

const HIT_GROUPS: Record<string, string> = {
  passenger_car: 'Car, SUV, pickup or van', suv: 'Car, SUV, pickup or van', pickup_truck: 'Car, SUV, pickup or van', van: 'Car, SUV, pickup or van',
  heavy_truck: 'Heavy truck or bus', bus: 'Heavy truck or bus',
  pedestrian: 'Pedestrian, cyclist or motorcyclist', cyclist: 'Pedestrian, cyclist or motorcyclist', motorcycle: 'Pedestrian, cyclist or motorcyclist',
  scooter_skateboard: 'Pedestrian, cyclist or motorcyclist', non_motorist_other: 'Pedestrian, cyclist or motorcyclist',
  fixed_object: 'Fixed object, pole or tree', pole_tree: 'Fixed object, pole or tree',
  animal: 'Animal',
  other: 'Other', first_responder_vehicle: 'Other',
};
export const hitGroup = (c: string | null | undefined) => (!c || c === 'unknown' ? 'Unknown or not reported' : HIT_GROUPS[c] ?? 'Other');

/** Where the subject vehicle was struck, grouped. */
export function impactGroup(areas: string[] | null | undefined): string {
  const zs = (areas ?? []).filter((z): z is Zone => (ZONES as readonly string[]).includes(z));
  if (zs.length === 0) return 'Unknown or not reported';
  const all = (set: Zone[]) => zs.every((z) => set.includes(z));
  if (all(FRONT)) return 'Front';
  if (all(REAR)) return 'Rear';
  if (all(SIDE)) return 'Side';
  if (zs.every((z) => z === 'top' || z === 'bottom')) return 'Roof or underbody';
  return 'Several areas';
}

/** Sankey id of a row's label node. Own motion is split by program kind so its wording stays exact. */
export function labelKey(r: Pick<RespRow, 'label' | 'program'>): string {
  if (r.label === 'subject_vehicle_initiated') return isL2(r.program) ? 'own_l2' : 'own_ads';
  return r.label;
}
export const LABEL_KEY_NAME: Record<string, string> = {
  other_party: OTHER_NAME, own_ads: OWN_ADS, own_l2: 'Own motion (driver or system, Level 2)', indeterminate: CANNOT_NAME,
};
/** The label (not the key) a label key belongs to. */
export const labelOfKey = (k: string): Label => (k === 'own_ads' || k === 'own_l2' ? 'subject_vehicle_initiated' : (k as Label));

export const COLUMNS = ['eng', 'mv', 'cw', 'ip', 'lb'] as const;
export const COLUMN_TITLE: Record<(typeof COLUMNS)[number], string> = {
  eng: 'Engagement', mv: 'Subject vehicle movement', cw: 'What was hit', ip: 'Impact point on the subject vehicle', lb: 'Inferred label',
};

/** Node ids along the flow (one per column) for a row, or null when the row has no structured record to read. */
export function pathOf(r: JoinedRow): string[] | null {
  if (!r.rec) return null;
  return [
    `eng:${isL2(r.program) ? 'l2' : 'ads'}`,
    `mv:${movementGroup(r.rec.sv_movement)}`,
    `cw:${hitGroup(r.rec.crash_with)}`,
    `ip:${impactGroup(r.rec.sv_contact_areas)}`,
    `lb:${labelKey(r)}`,
  ];
}

export const NODE_NAME = (id: string): string => {
  const [col, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (col === 'eng') return key === 'ads' ? 'Automated driving system (ADS)' : 'Driver assistance (Level 2)';
  if (col === 'lb') return LABEL_KEY_NAME[key] ?? key;
  return key;
};

export type SankeyGraph = {
  nodes: { id: string; col: number; value: number }[];
  links: { source: string; target: string; value: number }[];
  /** Rows drawn / rows left out because their structured fields are not in records.json. */
  drawn: number;
  skipped: number;
};

export function buildSankey(rows: JoinedRow[]): SankeyGraph {
  const nodes = new Map<string, { id: string; col: number; value: number }>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  let drawn = 0;
  let skipped = 0;
  for (const r of rows) {
    const p = pathOf(r);
    if (!p) {
      skipped++;
      continue;
    }
    drawn++;
    p.forEach((id, col) => {
      const n = nodes.get(id) ?? { id, col, value: 0 };
      n.value++;
      nodes.set(id, n);
      if (col > 0) {
        const k = `${p[col - 1]}|${id}`;
        const l = links.get(k) ?? { source: p[col - 1], target: id, value: 0 };
        l.value++;
        links.set(k, l);
      }
    });
  }
  const order = (a: { col: number; value: number; id: string }, b: { col: number; value: number; id: string }) => a.col - b.col || b.value - a.value || a.id.localeCompare(b.id);
  return { nodes: [...nodes.values()].sort(order), links: [...links.values()].sort((a, b) => b.value - a.value), drawn, skipped };
}

// ---------- rule evidence ----------

const EV = {
  mov: 'sv_movement', area: 'sv_contact_areas', cw: 'crash_with', cpm: 'cp_movement', spd: 'speed_mph',
} as const;
/** Structured fields each rule reads, shown as field=value in the drawer. */
export const RULE_EVIDENCE: Record<string, string[]> = {
  'RESP-OTH-1': [EV.mov, EV.area, EV.cw],
  'RESP-OTH-2': [EV.area, EV.mov, EV.cw],
  'RESP-OTH-3': [EV.cpm, EV.mov, EV.area, EV.cw],
  'RESP-OTH-4': [EV.area, EV.mov, EV.cw],
  'RESP-SUB-1': [EV.mov],
  'RESP-SUB-2': [EV.cw, EV.mov, EV.spd],
  'RESP-SUB-3': [EV.area, EV.cpm, EV.mov],
  'RESP-IND-1': [EV.mov, EV.area],
  'RESP-IND-2': [EV.mov, EV.area, EV.cpm, EV.cw],
  'RESP-IND-3': [EV.mov, EV.area, EV.cpm, EV.cw, EV.spd],
  'RESP-IND-4': [EV.mov, EV.area, EV.cpm],
  'RESP-NAR-1': [EV.mov, EV.area, EV.cw],
};

const show = (v: unknown): string => (v == null ? 'not reported' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none listed') : String(v));
export function evidenceFor(r: JoinedRow): { field: string; value: string }[] {
  const fields = RULE_EVIDENCE[r.rule] ?? [];
  if (!r.rec) return [];
  const rec = r.rec as unknown as Record<string, unknown>;
  return fields.map((f) => ({ field: f, value: show(rec[f]) }));
}

// ---------- CSV ----------

export const CSV_HEAD = [
  'report_id', 'incident_key', 'program', 'month', 'label', 'label_display', 'confidence', 'basis', 'rule', 'severity',
  'crash_with', 'sv_movement', 'cp_movement', 'speed_mph', 'sv_contact_areas', 'cp_contact_areas',
];

/** CSV of the listed rows (RFC 4180 quoting, header first, CRLF). Structured fields are blank when the report has no record. */
export function toCsv(rows: JoinedRow[]): string {
  const lines = [CSV_HEAD.join(',')];
  for (const r of rows) {
    const c = r.rec;
    lines.push(
      [
        r.report_id, r.incident_key, r.program, r.month ?? '', r.label, labelName(r.label, r.program), r.confidence, r.basis, r.rule, r.severity,
        c?.crash_with ?? '', c?.sv_movement ?? '', c?.cp_movement ?? '', c?.speed_mph ?? '',
        (c?.sv_contact_areas ?? []).join(';'), (c?.cp_contact_areas ?? []).join(';'),
      ].map(csvCell).join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------- comparison strip ----------

export const ADS_PROGRAMS = ['waymo_ads', 'zoox_ads', 'gm_cruise_ads', 'tesla_robotaxi', 'other_ads'];

export type ComparisonRow = {
  program: string;
  /** Reports whose narrative is readable (not redacted) and whose structured record is in records.json. */
  readable: number;
  readableOtherHigh: number;
  all: number;
  allOtherHigh: number;
};

/** Per ADS program: of the reports with a readable narrative, the share labelled other party with high confidence. */
export function comparisonStrip(rows: JoinedRow[]): ComparisonRow[] {
  return ADS_PROGRAMS.map((program) => {
    const mine = rows.filter((r) => r.program === program);
    const readable = mine.filter((r) => r.rec && !r.rec.narrative_redacted);
    const hi = (r: JoinedRow) => r.label === 'other_party' && r.confidence === 'high';
    return { program, readable: readable.length, readableOtherHigh: readable.filter(hi).length, all: mine.length, allOtherHigh: mine.filter(hi).length };
  }).filter((c) => c.all > 0);
}
