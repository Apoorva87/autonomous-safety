import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart, SourceNote } from './EChart';
import { PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { scopedCounts, useRatesData, type RatesData } from './data/rates';
import { monthlySeries } from './lib/learning';
import { KIND_GROUPS, kindLabel, type KindId } from './lib/kinds';
import { esc, fmtNum } from './lib/format';
import {
  NUMERATOR_BY_ID, PROGRAM_SETUP, countedCrashes, forestRows, quarterSeries, usableMonths,
  type ForestRow, type MonthExposure, type QuarterPoint,
} from './lib/improve';
import type { Verdict } from './lib/stats';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { Forest, type ForestItem } from './components/Forest';
import { KindCaveat } from './components/KindCaveat';
import { RegimeBadge, RobustNote } from './components/Regime';
import { SourcesCtx } from './components/SourceBadge';

// "Is it improving?": per program, threshold-robust crash rates before and after the 2025-06-16 reporting-rule change,
// with the rate ratio, its exact interval and a plain-language verdict computed from the interval.

const RATED: Record<KindId, string[]> = { ads: ['waymo_ads', 'gm_cruise_ads'], l2: ['gm_supercruise', 'tesla_l2'] };

type ProgramResult = {
  program: string;
  months: MonthExposure[];
  rows: ForestRow[];
  quarters: { robust: QuarterPoint[]; all: QuarterPoint[] };
  estimate: boolean;
};

const VERDICT_CLASS: Record<Verdict['code'], string> = {
  no_change: 'v-none', lower: 'v-lower', higher: 'v-higher', insufficient: 'v-insufficient', no_denominator: 'v-insufficient',
};

export function Improvement({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the exposure files ({error}).</p>;
  if (!rates) return <p className="loading">Loading exposure and counts…</p>;
  return <Loaded data={data} rates={rates} mode={mode} />;
}

function Loaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario] = useScenario();
  const t = ui(mode);
  const kind: KindId = params.get('ik') === 'l2' ? 'l2' : 'ads';
  const rated = RATED[kind];
  const program = rated.includes(params.get('ip') ?? '') ? (params.get('ip') as string) : rated[0];

  const results = useMemo(() => {
    const out: Record<string, ProgramResult> = {};
    for (const p of [...RATED.ads, ...RATED.l2]) {
      const s = PROGRAM_SETUP[p];
      if (!s.region || !s.metric) continue;
      const counts = scopedCounts(rates.countRows, data.crashes, p, s.region, { riderOnly: scenario.riderOnly });
      // Plain scenario: the improvement view never applies window factors, lag adjustment or user assumptions.
      const plain = { ...scenario, windowFactor: 1, lagAdjust: false, estimates: {}, countBy: 'crashes' as const };
      const pts = monthlySeries(counts, rates.exposure, plain, { program: p, region: s.region, metric: s.metric, lastMonth: rates.lastMonth, lag: rates.lag[p] });
      const months = usableMonths(pts, rates.lag[p], rates.lastMonth);
      const cs = countedCrashes(data.crashes, p, scenario.riderOnly);
      out[p] = {
        program: p, months, rows: forestRows(cs, months, s.scale),
        quarters: {
          robust: quarterSeries(cs, months, NUMERATOR_BY_ID.robust.test, s.scale),
          all: quarterSeries(cs, months, NUMERATOR_BY_ID.all.test, s.scale),
        },
        estimate: months.some((m) => m.estimate),
      };
    }
    return out;
  }, [rates, data.crashes, scenario]);

  const sel = results[program];
  const setup = PROGRAM_SETUP[program];
  const color = colorOf(PROGRAM_BY_KEY[program].color, mode);
  const kindPrograms = KIND_GROUPS.find((g) => g.id === kind)!.programs;

  const forestItems: ForestItem[] = (sel?.rows ?? []).map((r) => ({
    key: r.numerator.id,
    label: <>{r.numerator.label}{r.numerator.note && <span className="small"> {r.numerator.note}</span>}</>,
    aria: `${r.numerator.label}: rate ratio ${r.rr.rr?.toFixed(2) ?? 'n/a'}, 95% interval ${r.rr.lo?.toFixed(2) ?? '?'} to ${r.rr.hi?.toFixed(2) ?? 'no upper bound'}`,
    rr: r.rr.rr, lo: r.rr.lo, hi: r.rr.hi, color: r.numerator.threshold ? t.muted : color, affected: r.numerator.threshold,
    empty: r.verdict.code === 'no_denominator' || r.verdict.code === 'insufficient' ? r.verdict.text : undefined,
    right: r.rr.rr != null ? <><b>{r.rr.rr.toFixed(2)}×</b> <span className="small">[{r.rr.lo?.toFixed(2) ?? '?'}, {r.rr.hi?.toFixed(2) ?? '∞'}]</span></> : null,
  }));

  const programItems: ForestItem[] = kindPrograms.map((p) => {
    const res = results[p];
    const robust = res?.rows.find((r) => r.numerator.id === 'robust');
    const info = PROGRAM_BY_KEY[p];
    const v = robust?.verdict;
    const empty = !robust || v?.code === 'no_denominator' ? PROGRAM_SETUP[p].why : v?.code === 'insufficient' ? v.text : undefined;
    return {
      key: p,
      label: <><i className="swatch" style={{ background: colorOf(info.color, mode) }} /> {info.short}{res?.estimate && <>{' '}<span className="small">(estimated {PROGRAM_SETUP[p].metric === 'per10kVeh' ? 'fleet' : 'miles'})</span></>}</>,
      aria: `${info.short}: ${v?.text ?? PROGRAM_SETUP[p].why}`,
      rr: robust?.rr.rr ?? null, lo: robust?.rr.lo ?? null, hi: robust?.rr.hi ?? null, color: colorOf(info.color, mode),
      empty,
      right: robust?.rr.rr != null && !empty ? <><b>{robust.rr.rr.toFixed(2)}×</b> <span className="small">[{robust.rr.lo?.toFixed(2)}, {robust.rr.hi?.toFixed(2)}]</span></> : null,
    };
  });

  const robustRow = sel?.rows.find((r) => r.numerator.id === 'robust');
  const allRow = sel?.rows.find((r) => r.numerator.id === 'all');

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="improve">
        <h2>Is it improving? Before and after the 2025-06-16 rule change</h2>
        <p className="prose">
          On 2025-06-16 NHTSA changed which crashes must be reported. Minor crashes stopped arriving, so any count of <em>all</em> reported crashes drops at that date
          whether or not driving changed. This page compares each program with itself, before and after the change, using only crashes that were reportable under
          both rules (any injury, an air bag, a tow-away for driverless programs, or a pedestrian or cyclist). It never says one program is safer than another.
        </p>
        <p><RegimeBadge robust /></p>
        <KindCaveat extra="Each kind group is shown on its own, and every ratio compares a program with itself." />

        <div className="controls">
          <div className="field">
            Kind group
            <div className="seg" role="group" aria-label="Kind group">
              {KIND_GROUPS.map((g) => (
                <button key={g.id} type="button" className={kind === g.id ? 'on' : ''} aria-pressed={kind === g.id}
                  onClick={() => setQuery({ ik: g.id === 'ads' ? null : g.id, ip: null })}>{g.label}</button>
              ))}
            </div>
          </div>
          <div className="field">
            Program
            <div className="seg" role="group" aria-label="Program">
              {rated.map((p) => (
                <button key={p} type="button" className={program === p ? 'on' : ''} aria-pressed={program === p}
                  onClick={() => setQuery({ ip: p === rated[0] ? null : p })}>{PROGRAM_BY_KEY[p].short}</button>
              ))}
            </div>
          </div>
        </div>

        <h3>Every {kindLabel(kind)} program: threshold-robust rate, after ÷ before</h3>
        <Forest items={programItems} caption={`Rate ratio of threshold-robust crashes after versus before 2025-06-16, ${kindLabel(kind)} programs`} />

        {sel && (
          <>
            <h3>{PROGRAM_BY_KEY[program].label}</h3>
            <div className={`verdict ${robustRow ? VERDICT_CLASS[robustRow.verdict.code] : ''}`} role="status">
              <span className="verdict-key">Threshold-robust crashes</span>
              <b>{robustRow?.verdict.text}</b>
              {robustRow && robustRow.pre.rate != null && robustRow.post.rate != null && (
                <span className="small">
                  Before: {fmt(robustRow.pre.k)} crashes over {fmtNum(robustRow.pre.e)} {setup.metric === 'per10kVeh' ? 'vehicle-years' : 'miles'} = {fmtNum(robustRow.pre.rate)} {setup.unit} [{fmtNum(robustRow.pre.lo)}, {fmtNum(robustRow.pre.hi)}]
                  {' · '}After: {fmt(robustRow.post.k)} over {fmtNum(robustRow.post.e)} = {fmtNum(robustRow.post.rate)} [{fmtNum(robustRow.post.lo)}, {fmtNum(robustRow.post.hi)}].
                </span>
              )}
              {allRow && allRow.rr.rr != null && (
                <span className="small">
                  For comparison, all reportable crashes: {fmtNum(allRow.pre.rate)} before and {fmtNum(allRow.post.rate)} after ({allRow.rr.rr.toFixed(2)}×), a drop the reporting change produces by itself.
                </span>
              )}
            </div>
            <p className="small">{setup.why}</p>
            {sel.months.length > 0 && (
              <p className="small">
                Months used: {sel.months.filter((m) => m.month < '2025-06').length} before ({sel.months.find((m) => m.month < '2025-06')?.month ?? 'none'} to 2025-05) and{' '}
                {sel.months.filter((m) => m.month > '2025-06').length} after (2025-07 to {sel.months.filter((m) => m.month > '2025-06').slice(-1)[0]?.month ?? 'none'}).
                June 2025 is left out (mixed: some of its reports were filed under each set of rules), and so are recent months whose reports are still arriving.
              </p>
            )}

            <h3>By numerator: which counts moved, and which did not</h3>
            <Forest items={forestItems} min={0.125} max={8} caption={`${PROGRAM_BY_KEY[program].short}: rate ratio after versus before 2025-06-16 for several numerators`} />

            <h3>Inside each regime</h3>
            <QuarterChart res={sel} unit={setup.unit} color={color} mode={mode} />
            <ForestTable rows={sel.rows} unit={setup.unit} vy={setup.metric === 'per10kVeh'} />
          </>
        )}

        <RobustNote kind={kind} />
        <div className="callout small">
          <h3>Read with care</h3>
          <ul>
            <li>Monthly miles are interpolated inside quarters, so the within-regime chart uses quarters, and the before/after ratios sum whole regimes.</li>
            <li>The driving itself changed too: new cities, freeways and vehicle platforms (Waymo), new software and many more miles. A flat ratio means the reported rate of consequential crashes did not measurably change, not that nothing changed.</li>
            <li>For rider-only programs only crashes with no one in the driver's seat are counted, to match rider-only miles (scenario panel on the Rates tab).</li>
            <li>Tesla Level 2 has no NHTSA-comparable miles: its ratio is per vehicle-year of an estimated fleet whose definition changes, and is not a safety rate.</li>
            <li>"Lower" or "higher" describes the reported rate only. Nothing here is a finding of safety or fault.</li>
          </ul>
        </div>
        <SourceNote date={data.meta.fetched_date} extra="Numerators: NHTSA SGO crashes (records.json, robust class from pipeline/derive.py). Denominators: exposure.json." />
      </section>
    </SourcesCtx.Provider>
  );
}

function QuarterChart({ res, unit, color, mode }: { res: ProgramResult; unit: string; color: string; mode: Mode }) {
  const t = ui(mode);
  const option = useMemo((): EChartsCoreOption => {
    // One category per quarter in order, with a gap slot at the break so neither line joins across it.
    const pre = res.quarters.robust.filter((q) => q.regime === 'pre');
    const post = res.quarters.robust.filter((q) => q.regime === 'post');
    const cats = [...pre.map((q) => q.label), '2025-06 (mixed, left out)', ...post.map((q) => q.label)];
    const gap = pre.length;
    const at = (qs: QuarterPoint[], key: 'rate' | 'lo' | 'hi') =>
      cats.map((c, i) => (i === gap ? null : qs.find((q) => q.label === c)?.[key] ?? null));
    const r = at(res.quarters.robust, 'rate');
    const lo = at(res.quarters.robust, 'lo');
    const hi = at(res.quarters.robust, 'hi');
    const a = at(res.quarters.all, 'rate');
    return {
      animation: false, textStyle: { color: t.muted },
      grid: { left: 46, right: 12, top: 18, bottom: 54 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (ps: any) => {
          const i = ps[0].dataIndex as number;
          if (i === gap) return 'June 2025: mixed month, left out';
          const q = res.quarters.robust.find((x) => x.label === cats[i]);
          const qa = res.quarters.all.find((x) => x.label === cats[i]);
          if (!q) return esc(cats[i]);
          return `<div style="font-size:12.5px"><b>${esc(q.label)}</b> (${q.regime === 'pre' ? 'before' : 'after'} the change)<br>Threshold-robust: <b>${fmtNum(q.rate)}</b> ${esc(unit)} [${fmtNum(q.lo)}, ${fmtNum(q.hi)}], ${q.k} crashes<br>All reportable: ${qa ? fmtNum(qa.rate) : 'n/a'} (${qa?.k ?? 0} crashes)${q.estimate ? '<br>Exposure is an estimate' : ''}</div>`;
        },
      },
      xAxis: {
        type: 'category', data: cats, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
        axisLabel: { color: t.muted, fontSize: 10, interval: 0, rotate: 35, formatter: (v: string) => (v.startsWith('2025-06') ? 'rule change' : v.replace(' (', '\n(')) },
      },
      yAxis: { type: 'value', min: 0, name: unit, nameTextStyle: { color: t.muted, fontSize: 10, align: 'left' }, axisLabel: { color: t.muted, fontSize: 10 }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        { name: 'All reportable crashes', type: 'line', data: a, connectNulls: false, symbol: 'circle', symbolSize: 5, lineStyle: { width: 1.5, color: t.faint }, itemStyle: { color: t.faint }, z: 1 },
        { name: 'band-lo', type: 'line', data: lo, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, connectNulls: false, silent: true, z: 2 },
        { name: 'band', type: 'line', data: hi.map((h, i) => (h == null || lo[i] == null ? null : h - (lo[i] as number))), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.18 }, connectNulls: false, silent: true, z: 2 },
        { name: 'Threshold-robust crashes', type: 'line', data: r, connectNulls: false, symbol: 'circle', symbolSize: 8, lineStyle: { width: 2.2, color }, itemStyle: { color, borderColor: t.surface, borderWidth: 1.5 }, z: 3,
          markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 1.5 }, data: [{ xAxis: gap }] } },
      ],
    };
  }, [res, unit, color, mode, t]);
  if (res.quarters.robust.length === 0) return <p className="callout small">No quarter has a usable denominator.</p>;
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title">Quarterly rate inside each regime, {unit}</span>
        <span className="panel-total"><RegimeBadge robust /></span>
      </figcaption>
      <EChart option={option} height={280} label={`Quarterly threshold-robust crash rate with 95% band, before and after 2025-06-16, not joined across the change; all reportable crashes as a faint line`} />
      <ul className="legend rates-legend">
        <li><span className="swatch" style={{ background: color }} /> Threshold-robust crashes, with exact 95% band</li>
        <li><span className="swatch" style={{ background: t.faint }} /> All reportable crashes (faint: the reporting threshold changed)</li>
        <li><span className="mk mk-break" /> 2025-06-16 rule change: the lines are not joined across it</li>
      </ul>
    </figure>
  );
}

function ForestTable({ rows, unit, vy }: { rows: ForestRow[]; unit: string; vy: boolean }) {
  return (
    <details className="table-view">
      <summary>Show the numbers as a table</summary>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Before and after counts, exposure, rates and rate ratios</caption>
          <thead>
            <tr>
              <th scope="col">Numerator</th>
              <th scope="col" className="num">Before: crashes</th>
              <th scope="col" className="num">Before: {vy ? 'vehicle-years' : 'miles'}</th>
              <th scope="col" className="num">Before: rate</th>
              <th scope="col" className="num">After: crashes</th>
              <th scope="col" className="num">After: {vy ? 'vehicle-years' : 'miles'}</th>
              <th scope="col" className="num">After: rate</th>
              <th scope="col">Ratio [95%]</th>
              <th scope="col">Reading</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.numerator.id}>
                <th scope="row">{r.numerator.label}</th>
                <td className="num">{fmt(r.pre.k)}</td>
                <td className="num">{fmtNum(r.pre.e)}</td>
                <td className="num">{r.pre.rate != null ? `${fmtNum(r.pre.rate)} [${fmtNum(r.pre.lo)}, ${fmtNum(r.pre.hi)}]` : 'no data'}</td>
                <td className="num">{fmt(r.post.k)}</td>
                <td className="num">{fmtNum(r.post.e)}</td>
                <td className="num">{r.post.rate != null ? `${fmtNum(r.post.rate)} [${fmtNum(r.post.lo)}, ${fmtNum(r.post.hi)}]` : 'no data'}</td>
                <td>{r.rr.rr != null ? `${r.rr.rr.toFixed(2)} [${r.rr.lo?.toFixed(2) ?? '?'}, ${r.rr.hi?.toFixed(2) ?? '∞'}]` : 'n/a'}</td>
                <td className="small">{r.verdict.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">Rates are {unit}. Intervals: exact Poisson for rates, conditional exact (binomial) for ratios.</p>
    </details>
  );
}

