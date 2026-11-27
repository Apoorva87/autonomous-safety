import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart } from './EChart';
import { PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { regionLabel, regionRateBlock, scopedCounts, useRatesData, type RatesData } from './data/rates';
import { defaultRegion } from './Rates';
import { series, type Measure, type Metric, type Point } from './lib/metrics';
import { esc, fmtNum } from './lib/format';
import { ci95 } from './lib/poisson';
import { KIND_GROUPS, type KindId } from './lib/kinds';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { ROBUST_LABEL, ALL_LABEL } from './components/Regime';

// Front-page rate charts: every program with a sourced denominator, per million miles and miles per crash,
// over the last 24 months (default) or by year from 2020. Driverless and Level 2 programs get separate panels
// because their reporting thresholds differ.

const PROGRAMS_BY_KIND: Record<KindId, string[]> = {
  ads: ['waymo_ads', 'gm_cruise_ads', 'tesla_robotaxi', 'zoox_ads'],
  l2: ['tesla_l2', 'gm_supercruise'],
};
export const TREND_MEASURES: { id: Measure; label: string }[] = [
  { id: 'robust', label: ROBUST_LABEL },
  { id: 'crashes', label: ALL_LABEL },
  { id: 'injury', label: 'Any injury' },
  { id: 'serious_plus', label: 'Serious or fatal injury' },
  { id: 'fatal', label: 'Fatal' },
  { id: 'vru', label: 'Pedestrian / cyclist' },
];
const NO_MILES: Record<string, string> = {
  zoox_ads: 'Zoox: no US miles disclosed (California DMV testing miles are not comparable).',
  gm_cruise_ads: 'GM Cruise: driverless miles only for 2023-03 to 2023-09; Cruise stopped driverless service in October 2023.',
  tesla_robotaxi: 'Tesla Robotaxi: one mileage counter only, spread evenly from the 2025-06-22 launch (rough).',
};
const LOW_K = 10;

type Row = { prog: string; region: string; pts: Map<string, Point>; hasAny: boolean };
/** What one chart point shows: crashes and miles over the period (or the 3-month window ending in it). */
type Cell = { k: number; e: number; rate: number; mpc: number | null; mpcLo: number | null; weak: boolean; months: number; kind: string | null; flags: string[] };

const prevMonths = (m: string, n: number) => lastMonths(m, n);
/** Rule-change segment of a period: before, the period containing 2025-06-16, after. */
const segOf = (per: string, annual: boolean) => {
  const b = annual ? '2025' : '2025-06';
  return per < b ? 0 : per === b ? 1 : 2;
};

export function cellOf(pts: Map<string, Point>, per: string, rolling: boolean, annual: boolean): Cell | null {
  const months = rolling ? prevMonths(per, 3) : [per];
  if (rolling && months.some((m) => segOf(m, false) !== segOf(per, false))) return null; // never span the rule change
  const ps = months.map((m) => pts.get(m));
  if (ps.some((p) => !p || p.exposure == null || !(p.exposure > 0) || p.rate == null)) return null;
  const list = ps as Point[];
  const k = list.reduce((a, p) => a + p.k, 0);
  const e = list.reduce((a, p) => a + (p.exposure as number), 0);
  const flags = [
    k < LOW_K ? 'few crashes' : '',
    list.some((p) => p.incomplete.length > 0) ? 'reports still arriving' : '',
    list.some((p) => p.flag) ? 'uneven miles split' : '',
    list.some((p) => p.exposureKind === 'estimate') ? 'miles estimated' : '',
    !annual || list[0].months.length === 12 ? '' : `${list[0].months.length} months with miles`,
  ].filter(Boolean);
  return {
    k, e, rate: (k / e) * 1e6, mpc: k > 0 ? e / k : null, mpcLo: k === 0 ? e / ci95(0)[1] : null,
    weak: k < LOW_K || flags.includes('reports still arriving') || flags.includes('uneven miles split'),
    months: months.length, kind: list.some((p) => p.exposureKind === 'estimate') ? 'estimate' : list[0].exposureKind, flags,
  };
}

function lastMonths(last: string, n: number): string[] {
  const [y, m] = last.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function RateTrends({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the exposure files ({error}).</p>;
  if (!rates) return <p className="loading">Loading miles and counts…</p>;
  return <Loaded data={data} rates={rates} mode={mode} />;
}

function Loaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario] = useScenario();
  const annual = params.get('ov') === 'y';
  const measure = (TREND_MEASURES.find((m) => m.id === params.get('on'))?.id ?? 'robust') as Measure;
  const rolling = !annual && params.get('os') !== '0';
  const lastYear = Number(rates.lastMonth.slice(0, 4));
  const periods = useMemo(
    () => (annual ? Array.from({ length: lastYear - 2020 + 1 }, (_, i) => String(2020 + i)) : lastMonths(rates.lastMonth, 24)),
    [annual, lastYear, rates.lastMonth],
  );

  const rows: Row[] = useMemo(() => {
    const plain = { ...scenario, windowFactor: 1, lagAdjust: false, estimates: {} };
    return [...PROGRAMS_BY_KIND.ads, ...PROGRAMS_BY_KIND.l2].map((prog) => {
      const region = defaultRegion(rates, prog, 'perM');
      const block = regionRateBlock(region);
      const counts = scopedCounts(rates.countRows, data.crashes, prog, block === 'global' ? 'us' : region, { riderOnly: scenario.riderOnly });
      const pts = new Map<string, Point>();
      const base = { program: prog, region, metric: 'perM' as Metric, lastMonth: rates.lastMonth, measure, lag: rates.lag[prog] };
      if (annual) for (const p of series(counts, rates.exposure, plain, { ...base, grain: 'year', firstYear: 2020 })) pts.set(p.period, p);
      else for (const y of [...new Set(prevMonths(rates.lastMonth, 26).map((m) => Number(m.slice(0, 4))))])
        for (const p of series(counts, rates.exposure, plain, { ...base, grain: 'month', year: y })) pts.set(p.period, p);
      const hasAny = periods.some((p) => cellOf(pts, p, false, annual) != null);
      return { prog, region, pts, hasAny };
    });
  }, [rates, data.crashes, scenario, measure, annual, periods]);

  const mLabel = { robust: 'threshold-robust crashes', crashes: 'all reportable crashes', injury: 'crashes with any injury', serious_plus: 'serious or fatal injury crashes', fatal: 'fatal crashes', vru: 'pedestrian or cyclist crashes' }[measure];
  const missing = rows.filter((r) => !r.hasAny);

  return (
    <div className="rate-trends">
      <div className="controls">
        <label className="field">
          Crash type
          <select value={measure} onChange={(e) => setQuery({ on: e.target.value === 'robust' ? null : e.target.value })}>
            {TREND_MEASURES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="field">
          Time axis
          <div className="seg" role="group" aria-label="Time axis">
            <button type="button" className={!annual ? 'on' : ''} aria-pressed={!annual} onClick={() => setQuery({ ov: null })}>Months, last 2 years</button>
            <button type="button" className={annual ? 'on' : ''} aria-pressed={annual} onClick={() => setQuery({ ov: 'y' })}>Years, 2020 on</button>
          </div>
        </div>
        {!annual && (
          <label className="check">
            <input type="checkbox" checked={rolling} onChange={(e) => setQuery({ os: e.target.checked ? null : '0' })} />
            3-month rolling rate (smooths months with few crashes)
          </label>
        )}
      </div>

      {(['perM', 'milesPerCrash'] as const).map((metric) => (
        <div key={metric}>
          <h3>{metric === 'perM' ? 'Crashes per million miles' : 'Miles per crash'} <span className="small">· {mLabel}{rolling ? ' · 3-month rolling' : ''}</span></h3>
          <div className="rate-pair">
            {KIND_GROUPS.map((g) => (
              <figure className="panel" key={g.id}>
                <figcaption><span className="panel-title">{g.label}</span></figcaption>
                <EChart
                  height={250}
                  label={`${metric === 'perM' ? 'Crashes per million miles' : 'Miles per crash'}, ${g.label}, ${annual ? 'by year from 2020' : 'by month, last 24 months'}`}
                  option={trendOption(rows.filter((r) => PROGRAMS_BY_KIND[g.id].includes(r.prog)), periods, metric, annual, rolling, mode)}
                />
                <ul className="legend rates-legend">
                  {rows.filter((r) => PROGRAMS_BY_KIND[g.id].includes(r.prog)).map((r) => (
                    <li key={r.prog} className={r.hasAny ? '' : 'muted'}>
                      <span className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[r.prog].color, mode) }} /> {PROGRAM_BY_KEY[r.prog].short}
                      <span className="small"> {r.hasAny ? `· ${regionLabel(r.region)}` : '· no miles in this range'}</span>
                    </li>
                  ))}
                </ul>
              </figure>
            ))}
          </div>
        </div>
      ))}
      <ul className="small trend-notes">
        <li>{rolling ? 'Each monthly point is the rate over that month and the two before it (never across the 2025-06-16 change). ' : ''}Hollow markers: fewer than {LOW_K} crashes, a month whose reports are still arriving, or a month whose miles are split from very uneven disclosures. Triangles on the miles-per-crash chart: no crash in that period, so the value is a lower bound.</li>
        <li>Miles are company disclosures (Waymo safety hub, GM and Tesla press releases and reports) turned into monthly figures by interpolating between dates, so most monthly values are estimates; hover a point for its crashes, miles and kind.</li>
        <li>Tesla L2 uses Tesla's North America FSD (Supervised) miles; the NHTSA counts also include Autopilot crashes, so its rate is high for FSD alone. Super Cruise miles include Canada. Driverless rates count only crashes with no one at the wheel, to match rider-only miles.</li>
        <li>Dashed line: 2025-06-16 rule change. {measure === 'crashes' ? 'All reportable crashes drop there because minor crashes stopped being reportable; pick threshold-robust crashes to compare across it.' : 'Threshold-robust and severity-based counts are reportable under both rules.'}</li>
        {missing.length > 0 && <li>No line: {missing.map((r) => NO_MILES[r.prog] ?? `${PROGRAM_BY_KEY[r.prog].short}: no miles in this range.`).join(' ')}</li>}
        <li>The <a href="#rates">Rates</a> view has the 95% intervals, every point as a table, and other denominators (per vehicle).</li>
      </ul>
    </div>
  );
}

function trendOption(rows: Row[], periods: string[], metric: 'perM' | 'milesPerCrash', annual: boolean, rolling: boolean, mode: Mode): EChartsCoreOption {
  const t = ui(mode);
  const breakAt = annual ? '2025' : '2025-06';
  const cells = rows.map((r) => periods.map((per) => cellOf(r.pts, per, rolling, annual)));
  // Lines are never joined across the rule change: before, the period that contains it, and after are separate series.
  const series = rows.flatMap((r, idx) => [0, 1, 2].map((seg) => {
    const color = colorOf(PROGRAM_BY_KEY[r.prog].color, mode);
    return {
      name: PROGRAM_BY_KEY[r.prog].short,
      type: 'line',
      connectNulls: false,
      showSymbol: true,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      data: periods.map((per, i) => {
        const c = cells[idx][i];
        if (segOf(per, annual) !== seg || !c) return null;
        const bound = metric === 'milesPerCrash' && c.mpc == null;
        const v = metric === 'perM' ? c.rate : c.mpc ?? c.mpcLo;
        return {
          value: v,
          symbol: bound ? 'triangle' : 'circle', // hollow look comes from the surface fill + coloured border (ECharts' emptyCircle strokes in the fill colour)
          symbolSize: bound ? 9 : c.weak ? 7 : 6,
          itemStyle: { color: c.weak || bound ? t.surface : color, borderColor: color, borderWidth: 1.6 },
        };
      }),
      ...(idx === 0 && seg === 0
        ? { markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 1.3 }, data: [{ xAxis: breakAt }] } }
        : {}),
    };
  }));
  return {
    animation: false,
    textStyle: { color: t.muted },
    grid: { left: metric === 'perM' ? 40 : 52, right: 10, top: 14, bottom: 26 },
    tooltip: {
      trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0]?.dataIndex ?? 0;
        const per = periods[i];
        const lines = rows.map((r, idx) => {
          const c = cells[idx][i];
          const name = esc(PROGRAM_BY_KEY[r.prog].short);
          if (!c) return `<div style="opacity:.6">${name}: no miles${rolling ? ' for all 3 months' : ''}</div>`;
          const val = metric === 'perM'
            ? `<b>${fmtNum(c.rate)}</b> per M miles`
            : c.mpc != null ? `<b>${fmtNum(c.mpc)}</b> miles / crash` : `at least <b>${fmtNum(c.mpcLo)}</b> miles / crash (no crash)`;
          return `<div>${name}: ${val} · ${fmt(c.k)} crashes / ${fmtNum(c.e)} miles${c.flags.length ? ` <span style="opacity:.7">(${c.flags.join(', ')})</span>` : ''}</div>`;
        });
        return `<div style="font-size:12.5px;max-width:340px;white-space:normal"><b>${esc(rolling ? `${prevMonths(per, 3)[0]} to ${per}` : per)}</b>${per === breakAt ? ' (rule change)' : ''}${lines.join('')}</div>`;
      },
    },
    xAxis: {
      type: 'category', data: periods, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
      axisLabel: { color: t.muted, fontSize: 10, interval: annual ? 0 : (_i: number, v: string) => /-(01|07)$/.test(v), formatter: (v: string) => (annual ? v : v.endsWith('-01') ? v.slice(0, 4) : v.slice(5) === '07' ? 'Jul' : v) },
    },
    yAxis: {
      type: 'value', min: 0, splitNumber: 4,
      axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => (metric === 'perM' ? String(v) : v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v)) },
      splitLine: { lineStyle: { color: t.grid } },
    },
    series,
  } as EChartsCoreOption;
}
