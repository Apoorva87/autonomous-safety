import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { EChart, SourceNote } from './EChart';
import { scopedCounts, useRatesData, type RatesData } from './data/rates';
import { learningCurve, monthlyPoints, type LearnPoint } from './lib/learning';
import { esc, fmtInt, fmtNum, hatchPattern } from './lib/format';
import { isNonDefault, setQuery, useQuery, useScenario } from './state/scenario';
import { getList, setList, toggleIn } from './state/viewstate';
import { ChipGroup } from './components/ChipGroup';
import { LowSampleMark, ScenarioBadge, SourceBadge, SourcesCtx } from './components/SourceBadge';

const REGION_ORDER = ['us', 'north_america'];

type Curve = { prog: string; label: string; color: string; region: string; pts: LearnPoint[]; first: string };

export function Learning({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the rates data files ({error}).</p>;
  if (!rates) return <p className="loading">Loading exposure and count data…</p>;
  return <LearningLoaded data={data} rates={rates} mode={mode} />;
}

function LearningLoaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario] = useScenario();
  const t = ui(mode);

  // Programs with MONTHLY miles in a national region. Annual-only and fleet-only disclosures cannot make a curve.
  const candidates = useMemo(() => {
    const out: { prog: string; region: string }[] = [];
    for (const p of ['waymo_ads', 'gm_supercruise', 'gm_cruise_ads', 'tesla_l2', 'tesla_robotaxi', 'zoox_ads']) {
      const region = REGION_ORDER.find((r) => rates.exposure.some((x) => x.program === p && x.region === r && x.metric === 'miles' && x.period.length === 7));
      if (region) out.push({ prog: p, region });
    }
    return out;
  }, [rates]);
  const without = ['tesla_l2', 'tesla_robotaxi', 'zoox_ads', 'other_ads', 'other_l2'].filter((p) => !candidates.some((c) => c.prog === p));

  const group = params.get('lg') === 'm' ? 'month' : 'quarter';
  const yMode = params.get('ly') === 'mpc' ? 'mpc' : 'rate';
  const picked = getList(params, 'lp').filter((p) => candidates.some((c) => c.prog === p));
  const active = picked.length ? picked : candidates.map((c) => c.prog);

  const curves: Curve[] = useMemo(
    () =>
      candidates
        .filter((c) => active.includes(c.prog))
        .map((c) => {
          const counts = scopedCounts(rates.countRows, data.crashes, c.prog, c.region);
          const monthly = monthlyPoints(counts, rates.exposure, scenario, { program: c.prog, region: c.region, lastMonth: rates.lastMonth, lag: rates.lag[c.prog] });
          const pts = learningCurve(monthly, { group, lastMonth: rates.lastMonth, lag: rates.lag[c.prog] });
          const first = monthly.find((p) => p.exposure != null)?.period ?? '';
          const info = PROGRAM_BY_KEY[c.prog];
          return { prog: c.prog, label: info.short, color: colorOf(info.color, mode), region: c.region, pts, first };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, active.join('|'), rates, data.crashes, scenario, group, mode],
  );

  const option = useMemo<EChartsCoreOption>(() => {
    const all = curves.flatMap((c) => c.pts);
    const xs = all.map((p) => p.cumMiles);
    const xMin = xs.length ? 10 ** Math.floor(Math.log10(Math.min(...xs))) : 1;
    const xMax = xs.length ? 10 ** Math.ceil(Math.log10(Math.max(...xs))) : 10;
    const yv = (p: LearnPoint, which: 'v' | 'lo' | 'hi') =>
      yMode === 'rate' ? (which === 'v' ? p.rate : which === 'lo' ? p.lo : p.hi) : which === 'v' ? p.mpc : which === 'lo' ? p.mpcLo : p.mpcHi;
    const ys = all.map((p) => yv(p, 'v')).filter((v): v is number => v != null);
    // Log vertical axis: driver-assist and driverless programs differ by two orders of magnitude, so a linear axis would flatten one of them.
    // Periods with no crash have no point on a log axis; they stay in the table below.
    const lows = all.map((p) => yv(p, 'lo')).filter((v): v is number => v != null && v > 0);
    const yTop = 10 ** Math.ceil(Math.log10((ys.length ? Math.max(...ys) : 1) * 1.2));
    const yBot = 10 ** Math.floor(Math.log10(lows.length ? Math.min(...lows) : 0.1));
    const yMax = yTop;
    const clip = (v: number | null) => (v == null ? yMax : Math.min(Math.max(v, yBot), yMax));
    const series: unknown[] = [];
    for (const c of curves) {
      const pts = c.pts.filter((p) => (yv(p, 'v') ?? 0) > 0);
      series.push({
        name: c.label, type: 'line', symbol: 'none', lineStyle: { color: c.color, width: 2 }, itemStyle: { color: c.color }, z: 2,
        data: pts.map((p) => [p.cumMiles, yv(p, 'v')]),
      });
      series.push({
        name: c.label + ' points', type: 'scatter', symbolSize: 13, z: 4,
        data: pts.map((p) => ({
          value: [p.cumMiles, yv(p, 'v'), p.period, p.k, p.miles, p.kind, yv(p, 'lo'), yv(p, 'hi'), p.recent ? 1 : 0, c.label],
          itemStyle: p.lowSample
            ? { color: hatchPattern(c.color), borderColor: c.color, borderWidth: 2 }
            : { color: c.color, borderColor: t.surface, borderWidth: 2 },
        })),
      });
      series.push({
        name: c.label + ' interval', type: 'custom', silent: true, z: 1, clip: true,
        data: pts.map((p) => [p.cumMiles, clip(yv(p, 'lo')), clip(yv(p, 'hi'))]),
        encode: { x: 0, y: [1, 2] },
        renderItem: (_: unknown, api: any) => {
          const x = api.value(0);
          const hi = api.coord([x, api.value(2)]);
          const lo = api.coord([x, api.value(1)]);
          const cap = (y: number) => ({ type: 'line', shape: { x1: hi[0] - 5, y1: y, x2: hi[0] + 5, y2: y }, style: { stroke: c.color, lineWidth: 1.5 } });
          return {
            type: 'group',
            children: [{ type: 'line', shape: { x1: hi[0], y1: hi[1], x2: lo[0], y2: lo[1] }, style: { stroke: c.color, lineWidth: 1.5, opacity: 0.8 } }, cap(hi[1]), cap(lo[1])],
          };
        },
      });
    }
    return {
      animation: false,
      textStyle: { color: t.muted },
      grid: { left: 66, right: 18, top: 24, bottom: 62 },
      legend: { bottom: 0, textStyle: { color: t.muted }, data: curves.map((c) => c.label), itemWidth: 14 },
      tooltip: {
        trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (p: any) => {
          if (p.seriesType !== 'scatter') return '';
          const [x, y, period, k, miles, kind, lo, hi, recent, label] = p.value;
          return `<b>${esc(label)}, ${esc(period)}</b><br>Miles since first disclosed month: ${esc(fmtNum(x))}<br>` +
            (yMode === 'rate'
              ? `${esc(fmtNum(y))} crashes per million miles (95% ${esc(fmtNum(lo))} to ${esc(fmtNum(hi))})`
              : `${esc(fmtNum(y))} miles per crash (95% ${esc(fmtNum(lo))} to ${hi == null ? 'no upper bound' : esc(fmtNum(hi))})`) +
            `<br>${esc(fmtInt(k))} crashes in ${esc(fmtNum(miles))} miles (${esc(kind)} miles)` +
            (recent ? '<br>Recent: reports still arriving, count probably low' : '');
        },
      },
      xAxis: {
        type: 'log', min: xMin, max: xMax, name: 'miles since first disclosed month (not lifetime miles), log scale', nameLocation: 'middle', nameGap: 30,
        nameTextStyle: { color: t.muted }, axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) },
        axisLine: { lineStyle: { color: t.rule } }, splitLine: { lineStyle: { color: t.grid } },
      },
      yAxis: {
        type: 'log', min: yBot, max: yMax, name: yMode === 'rate' ? 'crashes per million miles' : 'miles per crash',
        nameTextStyle: { color: t.muted, align: 'left', fontSize: 11 }, axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) },
        splitLine: { lineStyle: { color: t.grid } },
      },
      series,
    } as EChartsCoreOption;
  }, [curves, yMode, mode, t.muted, t.surface, t.rule, t.ink, t.grid]);

  const noPoints = curves.every((c) => c.pts.length === 0);
  const rows = curves.flatMap((c) => c.pts.map((p) => ({ c, p })));
  const sourceIds = [...new Set(rows.flatMap((r) => r.p.sourceIds))];

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="learning">
        <h2>Learning curves: rate against miles since first disclosure</h2>
        <p className="prose">
          Does the crash rate fall as a program accumulates miles? Each point is one calendar quarter (or month) with its exact Poisson 95% interval, placed at the
          miles accumulated since the program's first disclosed month, to the end of that period (not lifetime miles). <b>A falling curve is not proof of learning</b>: service areas, roads, software, vehicle mix and what gets
          reported all change together over the same miles. Hatched points are low-count or rest on estimated miles. Reports lag, so the latest points sit low until later reports arrive.
        </p>
        <div className="rates-controls">
          <ChipGroup
            legend="Programs"
            options={candidates.map((c) => ({ value: c.prog, label: PROGRAM_BY_KEY[c.prog].short, color: colorOf(PROGRAM_BY_KEY[c.prog].color, mode) }))}
            selected={picked}
            onToggle={(v) => setList('lp', toggleIn(picked, v))}
            onClear={() => setList('lp', [])}
          />
        </div>
        <div className="controls">
          <div className="field">
            Show
            <div className="seg" role="group" aria-label="What the vertical axis shows">
              <button type="button" className={yMode === 'rate' ? 'on' : ''} aria-pressed={yMode === 'rate'} onClick={() => setQuery({ ly: null })}>Crashes per million miles</button>
              <button type="button" className={yMode === 'mpc' ? 'on' : ''} aria-pressed={yMode === 'mpc'} onClick={() => setQuery({ ly: 'mpc' })}>Miles per crash</button>
            </div>
          </div>
          <div className="field">
            Period
            <div className="seg" role="group" aria-label="Period size">
              <button type="button" className={group === 'quarter' ? 'on' : ''} aria-pressed={group === 'quarter'} onClick={() => setQuery({ lg: null })}>Quarter</button>
              <button type="button" className={group === 'month' ? 'on' : ''} aria-pressed={group === 'month'} onClick={() => setQuery({ lg: 'm' })}>Month</button>
            </div>
          </div>
        </div>

        {noPoints ? (
          <p className="callout small">No selected program has a full period with disclosed miles.</p>
        ) : (
          <figure className="panel rates-chart">
            <figcaption>
              <span className="panel-title">
                {yMode === 'rate' ? 'Crashes per million miles' : 'Miles per crash'} against miles since the first disclosed month
                {isNonDefault(scenario) && <> <ScenarioBadge title="You changed an assumption on the Rates tab (window factor, lag adjustment, count by); it applies here too" /></>}
              </span>
              <span className="panel-total">
                Points: {group === 'quarter' ? 'calendar quarters' : 'months'} · whiskers: exact Poisson 95% interval · log-log axes
                <SourceBadge sourceIds={sourceIds} label="Sources for these points" />
              </span>
            </figcaption>
            <EChart
              option={option} height={420}
              label={`Learning curves: ${yMode === 'rate' ? 'crash rate' : 'miles per crash'} against miles since the first disclosed month (not lifetime miles) for ${curves.map((c) => c.label).join(', ')}`}
            />
            <ul className="legend rates-legend">
              {curves.map((c) => (
                <li key={c.prog}>
                  <span className="swatch" style={{ background: c.color }} /> {c.label}: {c.pts.length} {group === 'quarter' ? 'quarters' : 'months'} from {c.first || 'n/a'} ({c.region === 'north_america' ? 'North America miles, includes Canada' : 'US miles'})
                </li>
              ))}
              <li><span className="mk mk-fill" /> filled: enough crashes, miles reported or derived</li>
              <li><span className="mk mk-hollow" /> hatched: fewer than 10 crashes or estimated miles</li>
            </ul>
            <p className="small">
              <b>Horizontal axis: miles since first disclosed month (not lifetime miles).</b> It counts miles from each program's first month with a monthly disclosure, not its lifetime total (lifetime miles before then are not in the
              data), so curves start left of where the company's true cumulative miles stand. Compare shapes, not horizontal positions across programs. Both axes are logarithmic, so equal distances are equal ratios; periods with no crashes cannot sit on a log axis and appear only in the table.
            </p>
          </figure>
        )}

        {without.length > 0 && (
          <p className="callout small">
            Not shown: {without.map((p) => PROGRAM_BY_KEY[p]?.short ?? p).join(', ')}. They have no monthly US or North America miles (Tesla discloses worldwide miles only;
            others disclose fleet size or California testing miles, which cannot make a national curve).
          </p>
        )}

        <h3>Every point</h3>
        <div className="table-wrap">
          <table className="rates-table">
            <caption className="sr-only">Learning-curve points</caption>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Period</th>
                <th scope="col" className="num">Miles since first disclosed month</th>
                <th scope="col" className="num">Miles in period</th>
                <th scope="col" className="num">Crashes</th>
                <th scope="col" className="num">Per million miles</th>
                <th scope="col">95% interval</th>
                <th scope="col" className="num">Miles per crash</th>
                <th scope="col">Flags</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, p }) => (
                <tr key={c.prog + p.period}>
                  <td><span className="swatch" style={{ background: c.color }} /> {c.label}</td>
                  <td>{p.period}</td>
                  <td className="num">{fmtNum(p.cumMiles)}</td>
                  <td className="num">{fmtNum(p.miles)} <span className="small">{p.kind}</span></td>
                  <td className="num">{fmtInt(p.k)}</td>
                  <td className="num"><b>{fmtNum(p.rate)}</b></td>
                  <td>{fmtNum(p.lo)} to {fmtNum(p.hi)}</td>
                  <td className="num">{p.mpc == null ? `more than ${fmtNum(p.mpcLo)}` : fmtNum(p.mpc)}</td>
                  <td>
                    {p.lowSample && <LowSampleMark />}
                    {p.recent && <span className="small"> recent: reports still arriving</span>}
                    {p.scenario && <ScenarioBadge />}
                  </td>
                  <td><SourceBadge sourceIds={p.sourceIds} kind={p.kind} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SourceNote date={data.meta.fetched_date} extra="Crashes: NHTSA SGO unique crashes. Miles: company disclosures and estimates (see each point's source)." />
      </section>
    </SourcesCtx.Provider>
  );
}
