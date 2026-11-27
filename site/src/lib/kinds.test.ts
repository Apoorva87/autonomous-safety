import { describe, expect, it } from 'vitest';
import { KIND_CAVEAT, KIND_GROUPS, kindOf, limitToKind, mixesKinds, singleKindItems, splitByKind, toggleWithinKind } from './kinds';
import { PROGRAMS } from '../theme';

describe('kind groups', () => {
  it('every program belongs to exactly one kind', () => {
    const all = KIND_GROUPS.flatMap((g) => g.programs);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(PROGRAMS.map((p) => p.key).sort());
    expect(kindOf('waymo_ads')).toBe('ads');
    expect(kindOf('tesla_robotaxi')).toBe('ads');
    expect(kindOf('tesla_l2')).toBe('l2');
    expect(kindOf('gm_supercruise')).toBe('l2');
    expect(kindOf('other_l2')).toBe('l2');
    expect(kindOf('entity:Foo')).toBeNull();
  });
  it('detects a selection that mixes kinds', () => {
    expect(mixesKinds(['waymo_ads', 'zoox_ads'])).toBe(false);
    expect(mixesKinds(['waymo_ads', 'gm_supercruise'])).toBe(true);
    expect(mixesKinds([])).toBe(false);
  });
  it('limitToKind keeps the kind of the first program (or an explicit kind) and preserves order', () => {
    expect(limitToKind(['gm_supercruise', 'waymo_ads', 'tesla_l2'])).toEqual(['gm_supercruise', 'tesla_l2']);
    expect(limitToKind(['waymo_ads', 'gm_supercruise', 'zoox_ads'])).toEqual(['waymo_ads', 'zoox_ads']);
    expect(limitToKind(['waymo_ads', 'gm_supercruise'], 'l2')).toEqual(['gm_supercruise']);
    expect(limitToKind([])).toEqual([]);
  });
  it('toggling a program of the other kind starts a new selection instead of mixing', () => {
    expect(toggleWithinKind(['waymo_ads'], 'zoox_ads')).toEqual(['waymo_ads', 'zoox_ads']);
    expect(toggleWithinKind(['waymo_ads', 'zoox_ads'], 'gm_supercruise')).toEqual(['gm_supercruise']);
    expect(toggleWithinKind(['waymo_ads', 'zoox_ads'], 'zoox_ads')).toEqual(['waymo_ads']);
    expect(toggleWithinKind([], 'tesla_l2')).toEqual(['tesla_l2']);
  });
  it('splitByKind never merges the groups', () => {
    const s = splitByKind([{ p: 'waymo_ads' }, { p: 'tesla_l2' }, { p: 'gm_cruise_ads' }, { p: 'x' }], (t) => t.p);
    expect(s.ads.map((t) => t.p)).toEqual(['waymo_ads', 'gm_cruise_ads']);
    expect(s.l2.map((t) => t.p)).toEqual(['tesla_l2']);
  });
  it('funnel guard: a pooled reference never spans kinds', () => {
    const pts = [
      { program: 'waymo_ads', kind: 'ads' as const }, { program: 'gm_supercruise', kind: 'l2' as const }, { program: 'zoox_ads', kind: 'ads' as const },
    ];
    expect(singleKindItems(pts).map((p) => p.program)).toEqual(['waymo_ads', 'zoox_ads']);
    expect(singleKindItems([pts[1], pts[0], pts[2]]).map((p) => p.program)).toEqual(['gm_supercruise']);
    expect(singleKindItems([])).toEqual([]);
  });
  it('the caveat text is the agreed wording', () => {
    expect(KIND_CAVEAT).toBe('Level 2 and ADS programs have different NHTSA reporting thresholds; their crash counts and rates are not comparable.');
  });
});
