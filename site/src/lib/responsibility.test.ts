import { describe, expect, it } from 'vitest';
import {
  CANNOT_NAME, OTHER_NAME, OWN_ADS, OWN_L2, aggregateByProgram, applyControls, applyFilters, buildSankey, comparisonStrip, evidenceFor,
  hitGroup, impactGroup, labelName, movementGroup, multiProgramIncidents, parseRows, pathOf, periodRange, periodShare,
  timeSeries, toCsv, NO_LIST_FILTERS, type RespFilters, type RespRow,
} from './responsibility';

const row = (o: Partial<RespRow>): RespRow => ({
  report_id: 'r1', report_key: 'r1|v1', incident_key: 'i1', program: 'waymo_ads', month: '2025-03', label: 'other_party', confidence: 'high',
  basis: 'field', rule: 'RESP-OTH-1', agent_hint: 'ads', severity: 'none', sv_movement: 'stopped', cp_movement: 'proceeding_straight',
  crash_with: 'passenger_car', sv_contact_areas: ['rear'], speed_band: '0', automation_engaged: 'ads',
  evidence: ['crash_with=passenger_car', 'sv_contact_areas=rear', 'sv_movement=stopped'], ...o,
});
const F = (o: Partial<RespFilters> = {}): RespFilters => ({ programs: [], severities: [], from: '', to: '', ...NO_LIST_FILTERS, ...o });

describe('label display', () => {
  it('words own motion by program kind and never mentions fault', () => {
    expect(labelName('subject_vehicle_initiated', 'tesla_l2')).toBe(OWN_L2);
    expect(labelName('subject_vehicle_initiated', 'gm_supercruise')).toBe('Own motion (driver or system; NHTSA data cannot separate them)');
    expect(labelName('subject_vehicle_initiated', 'other_l2')).toBe(OWN_L2);
    expect(labelName('subject_vehicle_initiated', 'waymo_ads')).toBe('Own motion (automated driving system)');
    expect(labelName('subject_vehicle_initiated', 'tesla_robotaxi')).toBe(OWN_ADS);
    expect(labelName('subject_vehicle_initiated')).toBe('Own motion');
    expect(labelName('other_party', 'tesla_l2')).toBe(OTHER_NAME);
    expect(labelName('indeterminate', 'waymo_ads')).toBe(CANNOT_NAME);
    for (const p of ['tesla_l2', 'waymo_ads', undefined]) for (const l of ['other_party', 'subject_vehicle_initiated', 'indeterminate'] as const) expect(labelName(l, p)).not.toMatch(/fault/i);
  });
});

describe('parseRows', () => {
  it('maps the columnar file to objects and expands the evidence index', () => {
    const fields = ['report_id', 'program', 'label', 'sv_contact_areas', 'evidence'];
    const [a, b] = parseRows({
      disclaimer: '', label_set: 'x', rules_version: '2', fields, evidence_sets: [['sv_movement=stopped'], ['crash_with=pole_tree', 'speed_mph=12']],
      rows: [['a-1', 'waymo_ads', 'other_party', ['rear'], 0], ['a-2', 'tesla_l2', 'indeterminate', null, 1]],
    });
    expect(a).toMatchObject({ report_id: 'a-1', program: 'waymo_ads', label: 'other_party', sv_contact_areas: ['rear'], evidence: ['sv_movement=stopped'] });
    expect(b.sv_contact_areas).toEqual([]);
    expect(b.evidence).toEqual(['crash_with=pole_tree', 'speed_mph=12']);
  });
});

describe('filters', () => {
  const j = [
    row({ report_id: 'a', incident_key: 'i1', program: 'waymo_ads', month: '2024-01', severity: 'minor' }),
    row({ report_id: 'b', incident_key: 'i2', program: 'tesla_l2', month: '2025-01', label: 'indeterminate', confidence: 'low', rule: 'RESP-IND-1', sv_movement: 'unknown', sv_contact_areas: [], crash_with: 'unknown' }),
    // second report of incident i1: carries its own fields and severity, so it filters like any other
    row({ report_id: 'c', incident_key: 'i1', program: 'zoox_ads', month: '2025-06', severity: 'minor', sv_contact_areas: ['front'], sv_movement: 'proceeding_straight' }),
    row({ report_id: 'd', incident_key: 'i3', program: 'waymo_ads', month: null }),
  ];
  it('filters by program, severity and month range; undated reports drop out of a range', () => {
    expect(applyControls(j, F({ programs: ['waymo_ads'] })).map((r) => r.report_id)).toEqual(['a', 'd']);
    expect(applyControls(j, F({ severities: ['minor'] })).map((r) => r.report_id)).toEqual(['a', 'c']);
    expect(applyControls(j, F({ from: '2024-06' })).map((r) => r.report_id)).toEqual(['b', 'c']);
    expect(applyControls(j, F({ to: '2025-01' })).map((r) => r.report_id)).toEqual(['a', 'b']);
  });
  it('filters the list by label, rule and flow selection, for every report including non-primary ones', () => {
    expect(applyFilters(j, F({ rule: 'RESP-IND-1' })).map((r) => r.report_id)).toEqual(['b']);
    expect(applyFilters(j, F({ label: 'indeterminate' })).map((r) => r.report_id)).toEqual(['b']);
    expect(applyFilters(j, F({ flow: 'mv:Stopped or parked' })).map((r) => r.report_id)).toEqual(['a', 'd']);
    expect(applyFilters(j, F({ flow: 'mv:Stopped or parked|cw:Car, SUV, pickup or van' })).map((r) => r.report_id)).toEqual(['a', 'd']);
    expect(applyFilters(j, F({ flow: 'mv:Stopped or parked|cw:Animal' }))).toEqual([]);
    expect(applyFilters(j, F({ flow: 'ip:Front' })).map((r) => r.report_id)).toEqual(['c']);
    expect(applyFilters(j, F({ flow: 'lb:other_party' })).map((r) => r.report_id)).toEqual(['a', 'c', 'd']);
  });
});

describe('aggregation by program', () => {
  const rows = [
    row({ report_id: '1', incident_key: 'x', program: 'waymo_ads' }),
    row({ report_id: '2', incident_key: 'y', program: 'waymo_ads', confidence: 'medium' }),
    row({ report_id: '3', incident_key: 'z', program: 'waymo_ads', label: 'indeterminate', confidence: 'low' }),
    row({ report_id: '4', incident_key: 'x', program: 'zoox_ads', label: 'subject_vehicle_initiated' }),
    row({ report_id: '5', incident_key: 'w', program: 'tesla_l2', label: 'indeterminate', confidence: 'low' }),
  ];
  it('gives counts by label and confidence and shares of each program, in program order, without a grand total', () => {
    const agg = aggregateByProgram(rows);
    expect(agg.map((a) => a.program)).toEqual(['tesla_l2', 'waymo_ads', 'zoox_ads']);
    const w = agg.find((a) => a.program === 'waymo_ads')!;
    expect(w.total).toBe(3);
    expect(w.counts.other_party).toEqual({ high: 1, medium: 1, low: 0 });
    expect(w.share.indeterminate).toBeCloseTo(1 / 3);
    expect(agg.find((a) => a.program === 'tesla_l2')!.share.indeterminate).toBe(1);
    expect(agg.some((a) => a.program === 'all')).toBe(false);
  });
  it('counts incidents that sit under more than one program (the overlap note)', () => {
    expect(multiProgramIncidents(rows)).toBe(1);
    expect(multiProgramIncidents([row({ incident_key: 'a' }), row({ incident_key: 'a' })])).toBe(0);
  });
});

describe('over time', () => {
  const rows = [row({ month: '2024-11' }), row({ month: '2025-01', label: 'indeterminate', confidence: 'low' }), row({ month: '2025-01' }), row({ month: null })];
  it('fills gaps in the period range', () => {
    expect(periodRange(['2024-11', '2025-01'], 'month')).toEqual(['2024-11', '2024-12', '2025-01']);
    expect(periodRange(['2023-05', '2025-01'], 'year')).toEqual(['2023', '2024', '2025']);
    expect(periodRange([], 'month')).toEqual([]);
  });
  it('counts per period and leaves undated reports out; shares are blank under the minimum', () => {
    const ts = timeSeries(rows, periodRange(['2024-11', '2025-01'], 'month'), 'month');
    expect(ts.totals).toEqual([1, 0, 2]);
    expect(ts.counts.other_party).toEqual([1, 0, 1]);
    expect(periodShare(ts, 'other_party', 2)).toEqual([null, null, 0.5]);
    expect(timeSeries(rows, ['2024', '2025'], 'year').totals).toEqual([1, 2]);
  });
});

describe('groupings and the flow diagram', () => {
  it('groups movement, partner and impact point', () => {
    expect(movementGroup('parked')).toBe('Stopped or parked');
    expect(movementGroup('u_turn')).toBe('Turning or changing lanes');
    expect(movementGroup(null)).toBe('Unknown or other');
    expect(hitGroup('suv')).toBe('Car, SUV, pickup or van');
    expect(hitGroup('cyclist')).toBe('Pedestrian, cyclist or motorcyclist');
    expect(hitGroup(null)).toBe('Unknown or not reported');
    expect(hitGroup('unknown')).toBe('Unknown or not reported');
    expect(hitGroup('other')).toBe('Other');
    expect(impactGroup(['rear', 'rear_left'])).toBe('Rear');
    expect(impactGroup(['front_right'])).toBe('Front');
    expect(impactGroup(['left'])).toBe('Side');
    expect(impactGroup(['front', 'left'])).toBe('Several areas');
    expect(impactGroup(['unknown'])).toBe('Unknown or not reported');
    expect(impactGroup(['bottom'])).toBe('Roof or underbody');
  });
  const rows = [
    row({ report_id: 'a', incident_key: 'i1' }),
    row({ report_id: 'b', incident_key: 'i2', program: 'tesla_l2', label: 'subject_vehicle_initiated', sv_movement: 'lane_departure', crash_with: 'fixed_object', sv_contact_areas: ['front'] }),
    row({ report_id: 'c', incident_key: 'i1', program: 'zoox_ads' }), // a non-primary report is drawn like any other
  ];
  it('has a five-column path per row and splits own motion by program kind', () => {
    expect(pathOf(rows[0])).toEqual(['eng:ads', 'mv:Stopped or parked', 'cw:Car, SUV, pickup or van', 'ip:Rear', 'lb:other_party']);
    expect(pathOf(rows[1])[0]).toBe('eng:l2');
    expect(pathOf(rows[1])[4]).toBe('lb:own_l2');
  });
  it('builds nodes and links whose values are conserved, drawing every report', () => {
    const g = buildSankey(rows);
    expect(g.drawn).toBe(3);
    expect(g.nodes.filter((n) => n.col === 0).reduce((s, n) => s + n.value, 0)).toBe(3);
    expect(g.nodes.filter((n) => n.col === 4).reduce((s, n) => s + n.value, 0)).toBe(3);
    for (const n of g.nodes.filter((x) => x.col > 0)) {
      expect(g.links.filter((l) => l.target === n.id).reduce((s, l) => s + l.value, 0)).toBe(n.value);
    }
    expect(g.links.every((l) => g.nodes.some((n) => n.id === l.source) && g.nodes.some((n) => n.id === l.target))).toBe(true);
  });
});

describe('evidence and CSV', () => {
  const a = row({ report_id: 'a' });
  const b = row({ report_id: 'zz', incident_key: 'i9', month: '2025-04', sv_contact_areas: ['rear', 'rear_left'], evidence: ['sv_contact_areas=rear;rear_left', 'speed_mph=3'] });
  it('lists the evidence as field=value, turning list values into words', () => {
    expect(evidenceFor(a)).toEqual([
      { field: 'crash_with', value: 'passenger_car' },
      { field: 'sv_contact_areas', value: 'rear' },
      { field: 'sv_movement', value: 'stopped' },
    ]);
    expect(evidenceFor(b)[0]).toEqual({ field: 'sv_contact_areas', value: 'rear, rear_left' });
    expect(evidenceFor(row({ evidence: [] }))).toEqual([]);
  });
  it('writes a quoted CSV with the displayed label wording and each report’s own fields', () => {
    const lines = toCsv([a, b]).trim().split('\r\n');
    expect(lines[0].startsWith('report_id,incident_key,program,month,label,label_display')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Other party involved/initiated');
    expect(lines[2]).toContain('rear;rear_left');
    expect(lines[2].startsWith('zz,i9,waymo_ads,2025-04,other_party')).toBe(true);
    expect(toCsv([row({ program: 'tesla_l2', label: 'subject_vehicle_initiated' })])).toContain(',Own motion (driver or system; NHTSA data cannot separate them),');
    expect(toCsv([row({ report_id: 'x,"y"' })]).split('\r\n')[1].startsWith('"x,""y""",')).toBe(true);
  });
});

describe('comparison strip', () => {
  it('covers ADS programs only, with the share labelled other party at high confidence', () => {
    const c = comparisonStrip([
      row({ report_id: 'a' }), row({ report_id: 'b', label: 'indeterminate', confidence: 'low' }), row({ report_id: 'c', confidence: 'medium' }),
      row({ report_id: 't', program: 'tesla_l2' }),
    ]);
    expect(c.map((x) => x.program)).toEqual(['waymo_ads']);
    expect(c[0]).toMatchObject({ all: 3, allOtherHigh: 1 });
  });
});
