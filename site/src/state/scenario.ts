import { useCallback, useMemo, useSyncExternalStore } from 'react';

// Scenario assumptions live in the URL query string so a view is shareable.
// Only values that differ from the default are written.

export type TeslaDenominator = 'fleet' | 'subscribers';
export type CountBy = 'crashes' | 'reports';

export type Scenario = {
  /** Capture factor applied to SGO counts (5 s window vs 30 s). 1 = SGO as filed. An assumption. */
  windowFactor: number;
  /** Tesla L2 denominator: US fleet (active vehicles) or worldwide FSD subscribers scaled by a US share. */
  teslaDenominator: TeslaDenominator;
  /** US share of worldwide subscribers (assumption), used only when teslaDenominator is "subscribers". */
  subsUsShare: number;
  /** Assumed miles per vehicle per year for programs with vehicles but no disclosed miles. */
  estimates: Record<string, { milesPerVehicleYear: number }>;
  lagAdjust: boolean;
  /** 1 = the empirical reporting-lag curve; 0 = no adjustment; 2 = twice the empirical correction. */
  lagMultiplier: number;
  countBy: CountBy;
};

/** Assumed miles per vehicle per year. These are assumptions, not disclosures. */
export const DEFAULT_MPV: Record<string, number> = {
  tesla_l2: 12000,
  tesla_robotaxi: 30000,
  zoox_ads: 30000,
  gm_cruise_ads: 30000,
  waymo_ads: 30000,
  gm_supercruise: 12000,
};
export const MPV_RANGE = { min: 2000, max: 80000, step: 500 };

export const DEFAULT_SCENARIO: Scenario = {
  windowFactor: 1,
  teslaDenominator: 'fleet',
  subsUsShare: 0.31,
  estimates: Object.fromEntries(Object.entries(DEFAULT_MPV).map(([k, v]) => [k, { milesPerVehicleYear: v }])),
  lagAdjust: false,
  lagMultiplier: 1,
  countBy: 'crashes',
};

export function mpvFor(s: Scenario, program: string): number {
  return s.estimates[program]?.milesPerVehicleYear ?? DEFAULT_MPV[program] ?? 12000;
}

export function mpvIsDefault(s: Scenario, program: string): boolean {
  return mpvFor(s, program) === (DEFAULT_MPV[program] ?? 12000);
}

/** True when the user changed any assumption that alters numbers. */
export function isNonDefault(s: Scenario): boolean {
  return (
    s.windowFactor !== 1 ||
    s.lagAdjust ||
    s.countBy !== 'crashes' ||
    s.teslaDenominator !== 'fleet' ||
    s.subsUsShare !== DEFAULT_SCENARIO.subsUsShare && s.teslaDenominator === 'subscribers'
  );
}

const num = (v: string | null, d: number, min: number, max: number) => {
  if (v == null || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
};

export function scenarioFromParams(p: URLSearchParams): Scenario {
  const s: Scenario = {
    ...DEFAULT_SCENARIO,
    estimates: { ...DEFAULT_SCENARIO.estimates },
    windowFactor: num(p.get('wf'), 1, 0.5, 5),
    teslaDenominator: p.get('td') === 'subs' ? 'subscribers' : 'fleet',
    subsUsShare: num(p.get('us'), DEFAULT_SCENARIO.subsUsShare, 0.05, 1),
    lagAdjust: p.get('lag') === '1',
    lagMultiplier: num(p.get('lm'), 1, 0, 2),
    countBy: p.get('cb') === 'reports' ? 'reports' : 'crashes',
  };
  for (const prog of Object.keys(DEFAULT_MPV)) {
    const v = p.get('mpv_' + prog);
    if (v != null) s.estimates[prog] = { milesPerVehicleYear: num(v, DEFAULT_MPV[prog], MPV_RANGE.min, MPV_RANGE.max) };
  }
  return s;
}

/** Query-param updates (null removes the key) that make `s` the URL state. */
export function scenarioToParams(s: Scenario): Record<string, string | null> {
  const out: Record<string, string | null> = {
    wf: s.windowFactor !== 1 ? String(s.windowFactor) : null,
    td: s.teslaDenominator === 'subscribers' ? 'subs' : null,
    us: s.subsUsShare !== DEFAULT_SCENARIO.subsUsShare ? String(s.subsUsShare) : null,
    lag: s.lagAdjust ? '1' : null,
    lm: s.lagMultiplier !== 1 ? String(s.lagMultiplier) : null,
    cb: s.countBy !== 'crashes' ? s.countBy : null,
  };
  for (const prog of Object.keys(DEFAULT_MPV)) {
    out['mpv_' + prog] = mpvIsDefault(s, prog) ? null : String(mpvFor(s, prog));
  }
  return out;
}

// ---- tiny URL query store (shared by scenario and the Rates view state) ----

const EVT = 'qs-change';
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVT, cb);
  };
};
const snapshot = () => window.location.search;

export function setQuery(updates: Record<string, string | null>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === '') p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new Event(EVT));
}

export function useQuery(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, snapshot, () => '');
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useScenario(): [Scenario, (patch: Partial<Scenario>) => void, () => void] {
  const params = useQuery();
  const scenario = useMemo(() => scenarioFromParams(params), [params]);
  const update = useCallback(
    (patch: Partial<Scenario>) => setQuery(scenarioToParams({ ...scenarioFromParams(new URLSearchParams(window.location.search)), ...patch })),
    [],
  );
  const reset = useCallback(() => setQuery(scenarioToParams(DEFAULT_SCENARIO)), []);
  return [scenario, update, reset];
}
