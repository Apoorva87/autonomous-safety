import { describe, expect, it } from 'vitest';
import { hasContactData, inZone, passesImpact, shadeOf, zoneStats, zonesOf, type WithContact } from './impact';
import { LENS_BY_ID } from './lens';
import type { Crash } from '../data';

const c = (o: Partial<WithContact>): WithContact =>
  ({ program: 'waymo_ads', severity: 'none', speed_band: '6-15', crash_with: 'passenger_car', tags: [], weather: [], lighting: null, sv_movement: 'proceeding_straight', month: '2025-03', ...o }) as WithContact;

describe('zone stats', () => {
  const rows = [
    c({ sv_contact_areas: ['rear'] }), c({ sv_contact_areas: ['rear', 'rear_left'] }), c({ sv_contact_areas: ['front'] }),
    c({ sv_contact_areas: ['unknown'] }), c({ sv_contact_areas: [] }), c({ sv_contact_areas: null }),
  ];
  it('shares use crashes with a known zone; multi-zone crashes count in each zone', () => {
    const s = zoneStats(rows, 'sv');
    expect(s.known).toBe(3);
    expect(s.unknown).toBe(3);
    expect(s.total).toBe(6);
    expect(s.counts.rear).toBe(2);
    expect(s.counts.rear_left).toBe(1);
    expect(s.counts.front).toBe(1);
    expect(s.counts.top).toBe(0);
  });
  it('the other party uses cp_contact_areas independently', () => {
    const s = zoneStats([c({ cp_contact_areas: ['front_right'] }), c({ sv_contact_areas: ['rear'] })], 'cp');
    expect(s.known).toBe(1);
    expect(s.counts.front_right).toBe(1);
  });
  it('zonesOf ignores values outside the ten zones; inZone lists matching crashes', () => {
    expect(zonesOf(c({ sv_contact_areas: ['rear', 'unknown', 'hood'] }), 'sv')).toEqual(['rear']);
    expect(inZone(rows, 'sv', 'rear')).toHaveLength(2);
  });
  it('detects whether records carry contact columns at all', () => {
    expect(hasContactData([c({})])).toBe(false);
    expect(hasContactData(rows)).toBe(true);
  });
  it('shade is relative to the largest share and clamped', () => {
    expect(shadeOf(0.2, 0.4)).toBe(0.5);
    expect(shadeOf(0.5, 0.4)).toBe(1);
    expect(shadeOf(0.1, 0)).toBe(0);
  });
});

describe('impact filters', () => {
  const f = { programs: [], severities: [], speedBands: [], crashWith: [], tags: [] };
  it('empty filters pass everything; each filter narrows', () => {
    expect(passesImpact(c({}), f)).toBe(true);
    expect(passesImpact(c({}), { ...f, programs: ['tesla_l2'] })).toBe(false);
    expect(passesImpact(c({ severity: 'fatal' }), { ...f, severities: ['fatal', 'serious'] })).toBe(true);
    expect(passesImpact(c({ speed_band: '51+' }), { ...f, speedBands: ['0', '1-5'] })).toBe(false);
    expect(passesImpact(c({ crash_with: null }), { ...f, crashWith: ['pedestrian'] })).toBe(false);
  });
  it('tags match on either basis; period bounds are inclusive', () => {
    expect(passesImpact(c({ tags: ['vru:n'] }), { ...f, tags: ['vru'] })).toBe(true);
    expect(passesImpact(c({ tags: ['low_speed:f'] }), { ...f, tags: ['vru'] })).toBe(false);
    expect(passesImpact(c({ month: '2025-03' }), { ...f, period: { from: '2025-03', to: '2025-03' } })).toBe(true);
    expect(passesImpact(c({ month: '2025-04' }), { ...f, period: { to: '2025-03' } })).toBe(false);
  });
});

describe('investigation lenses', () => {
  const t = (o: Partial<Crash>) => c({ program: 'tesla_l2', ...o }) as Crash;
  it('EA26002: dark, dawn/dusk, low-visibility weather or the glare tag; Tesla L2 only', () => {
    const ea = LENS_BY_ID.EA26002.test;
    expect(ea(t({ lighting: 'dark_unlit' }))).toBe(true);
    expect(ea(t({ lighting: 'dawn_dusk' }))).toBe(true);
    expect(ea(t({ weather: ['fog'] }))).toBe(true);
    expect(ea(t({ weather: ['clear'], lighting: 'daylight' }))).toBe(false);
    expect(ea(t({ tags: ['visibility_glare:n'] }))).toBe(true);
    expect(ea(c({ lighting: 'dark_unlit' }) as Crash)).toBe(false);
  });
  it('PE25012: intersection/signal tag or wrong-way / lane-departure movement; Tesla L2 only', () => {
    const pe = LENS_BY_ID.PE25012.test;
    expect(pe(t({ tags: ['intersection_signal:f'] }))).toBe(true);
    expect(pe(t({ sv_movement: 'wrong_way' }))).toBe(true);
    expect(pe(t({ sv_movement: 'lane_departure' }))).toBe(true);
    expect(pe(t({ sv_movement: 'proceeding_straight' }))).toBe(false);
    expect(pe(c({ tags: ['intersection_signal:f'] }) as Crash)).toBe(false);
  });
});
