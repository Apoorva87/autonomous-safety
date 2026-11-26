import { describe, expect, it } from 'vitest';
import {
  clampRange, dateMs, laneOfEvent, makeScale, niceCeil, makeTicks, msToDate, packLanes, panRange, periodForEvent, periodForInvestigation, zoomRange,
} from './timeline';

const bounds = { t0: dateMs('2021-01-01'), t1: dateMs('2026-12-31') };

describe('timeline helpers', () => {
  it('dateMs / msToDate round trip, month-only dates fall on the 1st', () => {
    expect(msToDate(dateMs('2025-06-16'))).toBe('2025-06-16');
    expect(msToDate(dateMs('2026-01'))).toBe('2026-01-01');
  });
  it('scale maps both ways', () => {
    const s = makeScale({ t0: 0, t1: 1000 }, 100, 300);
    expect(s.x(500)).toBe(200);
    expect(s.t(100)).toBe(0);
    expect(s.t(s.x(321))).toBeCloseTo(321, 9);
  });
  it('clamp keeps the range inside bounds and at least minSpan wide', () => {
    const r = clampRange({ t0: dateMs('2020-01-01'), t1: dateMs('2020-01-05') }, bounds);
    expect(r.t0).toBe(bounds.t0);
    expect(r.t1 - r.t0).toBeGreaterThanOrEqual(60 * 86_400_000);
    const r2 = clampRange({ t0: dateMs('2026-11-01'), t1: dateMs('2027-06-01') }, bounds);
    expect(r2.t1).toBe(bounds.t1);
  });
  it('zoom keeps the anchor fraction fixed; pan shifts without resizing', () => {
    const r = { t0: dateMs('2023-01-01'), t1: dateMs('2025-01-01') };
    const z = zoomRange(r, 0.5, 0.5, bounds);
    expect(z.t1 - z.t0).toBeCloseTo((r.t1 - r.t0) / 2, -3);
    expect((z.t0 + z.t1) / 2).toBeCloseTo((r.t0 + r.t1) / 2, -3);
    const p = panRange(r, 0.25, bounds);
    expect(p.t1 - p.t0).toBe(r.t1 - r.t0);
    expect(p.t0).toBeGreaterThan(r.t0);
    expect(panRange({ t0: bounds.t0, t1: bounds.t0 + 1e10 }, -1, bounds).t0).toBe(bounds.t0);
  });
  it('ticks: years for long spans, months for short', () => {
    expect(makeTicks(bounds).map((t) => t.label)).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
    const short = makeTicks({ t0: dateMs('2025-05-01'), t1: dateMs('2025-08-31') }).map((t) => t.label);
    expect(short).toEqual(['May', 'Jun', 'Jul', 'Aug']);
  });
  it('packLanes puts overlapping spans on different lanes and reuses freed lanes', () => {
    const d = dateMs;
    const { lane, lanes } = packLanes([
      { id: 'A', start: d('2022-02-16'), end: d('2026-06-29') },
      { id: 'B', start: d('2022-06-08'), end: d('2024-04-25') },
      { id: 'C', start: d('2024-04-25'), end: d('2026-01-01') },
      { id: 'D', start: d('2026-07-01'), end: d('2026-08-01') },
    ]);
    expect(lane.A).toBe(0);
    expect(lane.B).toBe(1);
    expect(lane.C).toBe(1); // B ended the day C started
    expect(lane.D).toBe(0); // A ended 2026-06-29
    expect(lanes).toBe(2);
    // no two spans on one lane overlap
    const spans = [['A', '2022-02-16', '2026-06-29'], ['B', '2022-06-08', '2024-04-25'], ['C', '2024-04-25', '2026-01-01'], ['D', '2026-07-01', '2026-08-01']];
    for (const x of spans) for (const y of spans) if (x[0] < y[0] && lane[x[0]] === lane[y[0]]) expect(dateMs(x[2]) <= dateMs(y[1]) || dateMs(y[2]) <= dateMs(x[1])).toBe(true);
  });
  it('event and investigation periods for the explorer filter', () => {
    expect(periodForEvent('2023-10-24', '2026-10')).toEqual({ from: '2023-10', to: '2023-12' });
    expect(periodForEvent('2025-11-15', '2026-01')).toEqual({ from: '2025-11', to: '2026-01' });
    expect(periodForEvent('2026-09-10', '2026-10')).toEqual({ from: '2026-09', to: '2026-10' });
    expect(periodForInvestigation('2026-03-18', '', '2026-10')).toEqual({ from: '2026-03', to: '2026-10' });
    expect(periodForInvestigation('2024-10-17', '2026-03-18', '2026-10')).toEqual({ from: '2024-10', to: '2026-03' });
  });
  it('niceCeil rounds axis maxima up to 1, 2, 4, 5 or 10 times a power of ten', () => {
    expect(niceCeil(13.2)).toBe(20);
    expect(niceCeil(20)).toBe(20);
    expect(niceCeil(3.1)).toBe(4);
    expect(niceCeil(0.037)).toBeCloseTo(0.04, 12);
    expect(niceCeil(0)).toBe(1);
  });
  it('event types map to lanes (reporting changes share the rules lane)', () => {
    expect(laneOfEvent('reporting_change')).toBe('regulatory');
    expect(laneOfEvent('launch')).toBe('launch');
    expect(laneOfEvent('mystery')).toBe('other');
  });
});
