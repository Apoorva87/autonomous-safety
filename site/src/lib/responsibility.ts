import { PROGRAMS } from '../theme';
import { ZONES, type Zone } from './impact';
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
  /** Distinct evidence sets ("field=value" lists); each row's `evidence` column indexes into this. */
  evidence_sets?: string[][];
  rows: unknown[][];
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
  /** Display fields of this report itself (not of the incident's primary report). */
  severity: string;
  sv_movement: string | null;
  cp_movement: string | null;
  crash_with: string | null;
  sv_contact_areas: string[];
  speed_band: string | null;
  automation_engaged: string | null;
  /** The rule's evidence as "field=value" pairs. */
  evidence: string[];
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
  const sets = file.evidence_sets ?? [];
  return file.rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const f of file.fields) o[f] = r[idx[f]];
    const ev = o.evidence;
    o.evidence = typeof ev === 'number' ? sets[ev] ?? [] : Array.isArray(ev) ? ev : [];
    o.sv_contact_areas = Array.isArray(o.sv_contact_areas) ? o.sv_contact_areas : [];
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
export function applyControls(rows: RespRow[], f: Pick<RespFilters, 'programs' | 'severities' | 'from' | 'to'>): RespRow[] {
  return rows.filter(
    (r) =>
      anyOf(f.programs, r.program) &&
      anyOf(f.severities, r.severity) &&
      (!f.from || (r.month ?? '') >= f.from) &&
      (!f.to || (r.month ?? '9999') <= f.to),
  );
}

/** Controls plus the list-only filters (label, rule, flow selection). */
export function applyFilters(rows: RespRow[], f: RespFilters): RespRow[] {
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
export function aggregateByProgram(rows: RespRow[]): ProgramAgg[] {
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
export function timeSeries(rows: RespRow[], periods: string[], grain: Grain): TimeSeries {
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

/** Node ids along the flow, one per column. */
export function pathOf(r: RespRow): string[] {
  return [
    `eng:${isL2(r.program) ? 'l2' : 'ads'}`,
    `mv:${movementGroup(r.sv_movement)}`,
    `cw:${hitGroup(r.crash_with)}`,
    `ip:${impactGroup(r.sv_contact_areas)}`,
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
  /** Reports drawn (every report in view). */
  drawn: number;
};

export function buildSankey(rows: RespRow[]): SankeyGraph {
  const nodes = new Map<string, { id: string; col: number; value: number }>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  let drawn = 0;
  for (const r of rows) {
    const p = pathOf(r);
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
  return { nodes: [...nodes.values()].sort(order), links: [...links.values()].sort((a, b) => b.value - a.value), drawn };
}

// ---------- rule evidence ----------

/** The label's evidence as {field, value} (parsed from "field=value"; list values stay "a;b" shown as "a, b"). */
export function evidenceFor(r: RespRow): { field: string; value: string }[] {
  return r.evidence.map((p) => {
    const i = p.indexOf('=');
    const field = i < 0 ? p : p.slice(0, i);
    const value = i < 0 ? '' : p.slice(i + 1).split(';').join(', ');
    return { field, value: value === '' ? 'not reported' : value };
  });
}

// ---------- CSV ----------

export const CSV_HEAD = [
  'report_id', 'incident_key', 'program', 'month', 'label', 'label_display', 'confidence', 'basis', 'rule', 'severity',
  'crash_with', 'sv_movement', 'cp_movement', 'speed_band', 'sv_contact_areas', 'automation_engaged', 'evidence',
];

/** CSV of the listed rows (RFC 4180 quoting, header first, CRLF). Every report carries its own fields. */
export function toCsv(rows: RespRow[]): string {
  const lines = [CSV_HEAD.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.report_id, r.incident_key, r.program, r.month ?? '', r.label, labelName(r.label, r.program), r.confidence, r.basis, r.rule, r.severity,
        r.crash_with ?? '', r.sv_movement ?? '', r.cp_movement ?? '', r.speed_band ?? '', r.sv_contact_areas.join(';'), r.automation_engaged ?? '',
        r.evidence.join(';'),
      ].map(csvCell).join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------- comparison strip ----------

export const ADS_PROGRAMS = ['waymo_ads', 'zoox_ads', 'gm_cruise_ads', 'tesla_robotaxi', 'other_ads'];

export type ComparisonRow = { program: string; all: number; allOtherHigh: number };

/** Per ADS program: the share of its reports labelled other party with high confidence. */
export function comparisonStrip(rows: RespRow[]): ComparisonRow[] {
  return ADS_PROGRAMS.map((program) => {
    const mine = rows.filter((r) => r.program === program);
    return { program, all: mine.length, allOtherHigh: mine.filter((r) => r.label === 'other_party' && r.confidence === 'high').length };
  }).filter((c) => c.all > 0);
}
