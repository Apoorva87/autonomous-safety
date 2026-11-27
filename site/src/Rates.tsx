import { useMemo } from 'react';
import type { Data } from './data';
import { fmt } from './data';
import { PROGRAM_BY_KEY, colorOf, type Mode } from './theme';
import { regionLabel, scopedCounts, useRatesData, type RatesData } from './data/rates';
import { metricNeeds, regionsFor, series, type Grain, type Measure, type Metric, type Point } from './lib/metrics';
import { METRICS, csvCell, fmtCI, fmtInt, fmtNum, fmtRateText, metricInfo } from './lib/format';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { DualAxisChart, type ChartSeries } from './components/DualAxisChart';
import { FunnelPlot, type FunnelPoint } from './components/FunnelPlot';
import { ScenarioPanel } from './components/ScenarioPanel';
import { CoverageMatrix } from './components/CoverageMatrix';
import { TeslaVsrPanel } from './components/TeslaVsrPanel';
import { FlagNote } from './components/FlagNote';
import { LowSampleMark, ScenarioBadge, SourceBadge, SourcesCtx } from './components/SourceBadge';

const GROUPS: { id: string; label: string; programs: string[] }[] = [
  { id: 'tesla', label: 'Tesla', programs: ['tesla_l2', 'tesla_robotaxi'] },
  { id: 'gm', label: 'GM', programs: ['gm_supercruise', 'gm_cruise_ads'] },
  { id: 'waymo', label: 'Waymo', programs: ['waymo_ads'] },
  { id: 'zoox', label: 'Zoox', programs: ['zoox_ads'] },
  { id: 'other', label: 'Other reporters', programs: ['other_ads', 'other_l2'] },
];
const ALL_PROGRAMS = GROUPS.flatMap((g) => g.programs);
const MEASURES: { id: Measure; label: string }[] = [
  { id: 'crashes', label: 'All crashes' },
  { id: 'injury', label: 'Any injury' },
  { id: 'serious_plus', label: 'Serious or fatal injury' },
  { id: 'fatal', label: 'Fatal' },
  { id: 'vru', label: 'Pedestrian / cyclist' },
];

const WHY: Record<string, string> = {
  tesla_l2:
    'Tesla Autopilot/FSD: only worldwide FSD miles are disclosed; NHTSA counts cannot be split between Autopilot and FSD, so there are no NHTSA-comparable US miles. Rates per active vehicle use US fleet counts quoted in NHTSA investigations (estimates). Miles exist only if you set an assumption in the scenario panel.',
  tesla_robotaxi:
    'Tesla Robotaxi: no miles are disclosed, and the only fleet figures are small estimates (Austin 2025-26, US in 2026), so most periods have no denominator.',
  gm_supercruise:
    'GM Super Cruise: North America miles are estimates interpolated between GM press disclosures (they include Canada), and vehicle counts are only reported for 2026. Crashes are all US reports, so read these rates as rough.',
  gm_cruise_ads:
    'GM Cruise: US miles are estimates for 2023-03 to 2023-09 only. California DMV testing miles are California-only and exclude commercial service. Cruise suspended driverless operations in October 2023 and was wound down in December 2024.',
  waymo_ads:
    'Waymo: US miles come from the Waymo Safety Impact hub from 2024-07 (the first months are derived; most months are interpolated estimates). Earlier years have no US miles; California DMV testing miles are California-only and the crash numerator is matched to California.',
  zoox_ads:
    'Zoox: only California DMV testing miles (California-only, testing only) and a small fleet estimate are available. There are no US miles.',
  other_ads: 'Other reporters: no exposure data is collected; only counts are available.',
  other_l2: 'Other reporters: no exposure data is collected; only counts are available.',
};

export function defaultRegion(rates: RatesData, program: string, metric: Metric): string {
  if (program.startsWith('entity:')) return 'us';
  const regs = regionsFor(rates.exposure, program);
  const has = (r: string, m: string) => rates.exposure.some((x) => x.program === program && x.region === r && x.metric === m);
  const order = regs.filter((r) => r !== 'global');
  const need = metricNeeds(metric) === 'vehicles' ? ['active_vehicles'] : ['miles', 'active_vehicles'];
  for (const m of need) {
    const r = order.find((x) => has(x, m));
    if (r) return r;
  }
  return order[0] ?? regs[0] ?? 'us';
}

type Computed = {
  prog: string;
  label: string;
  short: string;
  color: string;
  region: string;
  regions: string[];
  points: Point[];
};

export function Rates({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the rates data files ({error}).</p>;
  if (!rates) return <p className="loading">Loading exposure and count data…</p>;
  return <RatesLoaded data={data} rates={rates} mode={mode} />;
}

function RatesLoaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario, updateScenario, resetScenario] = useScenario();
  const lastYear = Number(rates.lastMonth.slice(0, 4));

  // ---- view state (URL) ----
  const picked = (params.get('p') ?? 'waymo_ads').split(',').filter((p) => ALL_PROGRAMS.includes(p));
  const entity = params.get('ent');
  const metric = (METRICS.find((m) => m.id === params.get('m'))?.id ?? 'perM') as Metric;
  const grain: Grain = params.get('g') === 'm' ? 'month' : 'year';
  const year = Math.min(lastYear, Math.max(2021, Number(params.get('y')) || lastYear));
  const showEvents = params.get('ev') !== '0';
  const measure = (MEASURES.find((m) => m.id === params.get('num'))?.id ?? 'crashes') as Measure;
  const refProg = params.get('ref') ?? '';
  const keys = [...picked, ...(entity ? [`entity:${entity}`] : [])];

  const setPicked = (list: string[]) => setQuery({ p: list.length ? list.join(',') : 'none' });
  const toggle = (p: string) => setPicked(picked.includes(p) ? picked.filter((x) => x !== p) : [...picked, p]);

  const entities = useMemo(() => {
    const c = new Map<string, number>();
    for (const x of data.crashes) c.set(x.entity, (c.get(x.entity) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.crashes]);

  // ---- computation ----
  const computed: Computed[] = useMemo(
    () =>
      keys.map((prog) => {
        const isEntity = prog.startsWith('entity:');
        const info = PROGRAM_BY_KEY[isEntity ? 'other_ads' : prog];
        const regions = isEntity ? ['us'] : regionsFor(rates.exposure, prog);
        const region = params.get('rg_' + prog) ?? defaultRegion(rates, prog, metric);
        const regionList = regions.includes(region) ? regions : [region, ...regions];
        const counts = scopedCounts(rates.countRows, data.crashes, prog, region === 'global' ? 'us' : region);
        const points = series(counts, rates.exposure, scenario, {
          program: prog, region, metric, grain, year, firstYear: 2019, lastMonth: rates.lastMonth, measure, lag: rates.lag[prog],
        });
        return {
          prog, region, regions: regionList, points,
          label: isEntity ? prog.slice(7) : info.label,
          short: isEntity ? prog.slice(7) : info.short,
          color: colorOf(info.color, mode),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys.join('|'), params, rates, data.crashes, scenario, metric, grain, year, measure, mode],
  );

  const chartSeries: ChartSeries[] = computed.map((c) => ({ key: c.prog, label: c.short, color: c.color, points: c.points }));
  const needs = metricNeeds(metric);
  const volumeUnit: 'miles' | 'vehicles' =
    needs === 'vehicles'
      ? 'vehicles'
      : needs === 'none'
        ? computed.flatMap((c) => c.points).find((p) => p.volume != null)?.volumeUnit ?? 'miles'
        : 'miles';
  const anyScenario = computed.some((c) => c.points.some((p) => p.scenario));
  const anyLow = computed.some((c) => c.points.some((p) => p.lowSample && p.rate != null));

  const events = showEvents
    ? rates.events.filter(
        (e) => (e.company === 'all' || keys.includes(e.program)) && (grain === 'year' || e.date.startsWith(String(year))),
      )
    : null;

  // Programs that need an assumed miles-per-vehicle (vehicles known, miles not) in their selected region.
  const mpvPrograms = computed
    .filter((c) => !c.prog.startsWith('entity:'))
    .filter((c) => {
      const rows = rates.exposure.filter((r) => r.program === c.prog && r.region === c.region);
      return rows.some((r) => r.metric === 'active_vehicles') && !rows.some((r) => r.metric === 'miles') && (needs === 'miles' || needs === 'none');
    })
    .map((c) => c.prog);

  // ---- why-no-data reasons ----
  const reasons = computed.map((c) => {
    const m = new Map<string, number>();
    for (const p of c.points) if (p.reason && !/began 2021-07/.test(p.reason)) m.set(p.reason, (m.get(p.reason) ?? 0) + 1);
    return { c, list: [...m.entries()].slice(0, 4), more: Math.max(0, m.size - 4) };
  });

  // ---- funnel plot: annual rates for every selected program ----
  const funnelMetric: Metric = metric === 'per10kVeh' ? 'per10kVeh' : metric === 'per1k' ? 'per1k' : 'perM';
  const funnelFactor = funnelMetric === 'per10kVeh' ? 1e4 : funnelMetric === 'per1k' ? 1e3 : 1e6;
  const funnel = useMemo(() => {
    const pts: FunnelPoint[] = [];
    const skipped: string[] = [];
    for (const c of computed) {
      const counts = scopedCounts(rates.countRows, data.crashes, c.prog, c.region === 'global' ? 'us' : c.region);
      const ps = series(counts, rates.exposure, scenario, {
        program: c.prog, region: c.region, metric: funnelMetric, grain: 'year', firstYear: 2021, lastMonth: rates.lastMonth, measure, lag: rates.lag[c.prog],
      });
      let n = 0;
      for (const p of ps)
        if (p.rate != null && p.exposure != null && p.exposure > 0 && !p.notes.some((n) => /assumed miles per vehicle/.test(n))) {
          n++;
          pts.push({ program: c.prog, label: c.short, color: c.color, period: p.period, rate: p.rate, exposure: p.exposure, k: p.k, lowSample: p.lowSample, scenario: p.scenario });
        }
      if (n === 0) skipped.push(c.short);
    }
    return { pts, skipped };
  }, [computed, rates, data.crashes, scenario, funnelMetric, measure]);

  // ---- table + CSV ----
  const tableRows = computed.flatMap((c) => c.points.map((p) => ({ c, p })));
  const downloadCsv = () => {
    const head = ['program', 'region', 'metric', 'period', 'crashes_raw', 'crashes_adjusted', 'exposure', 'exposure_unit', 'exposure_kind', 'rate', 'ci95_lo', 'ci95_hi', 'low_sample', 'scenario', 'partial_period', 'months_used', 'reason', 'source_ids', 'method'];
    const lines = [head.join(',')];
    for (const { c, p } of tableRows)
      lines.push(
        [c.prog, c.region, metric, p.period, p.k, p.kAdj, p.exposure ?? '', p.exposure != null ? p.volumeUnit : '', p.exposureKind ?? '', p.rate ?? '', p.lo ?? '', p.hi ?? '', p.lowSample, p.scenario, p.partial, p.months.length, p.reason ?? '', p.sourceIds.join(';'), p.method]
          .map(csvCell)
          .join(','),
      );
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `autonomous-safety-rates-${metric}-${grain === 'year' ? 'annual' : year}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const info = metricInfo(metric);
  const allSourceIds = [...new Set(computed.flatMap((c) => c.points.flatMap((p) => p.sourceIds)))];
  const chartSummary = `${info.label} for ${computed.map((c) => c.short).join(', ') || 'no program'}, ${grain === 'year' ? 'annual 2019 to ' + lastYear : 'monthly ' + year}, with 95% interval bands and exposure on the right axis.`;

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="rates">
        <h2>Rates, with their uncertainty</h2>
        <p className="prose">
          Crashes divided by exposure (miles or vehicles), only where a sourced denominator exists for the <em>same</em> region and months. Every rate shows an
          exact Poisson 95% interval. Hatched bands and hollow markers mean a low sample (fewer than 10 crashes) or an estimated denominator. Where no denominator exists,
          the chart says so instead of drawing a zero.
        </p>

        {/* ---- controls ---- */}
        <div className="rates-controls">
          {GROUPS.map((g) => (
            <fieldset className="prog-group" key={g.id}>
              <legend>{g.label}</legend>
              {g.programs.map((p) => (
                <label className="prog-chip" key={p}>
                  <input type="checkbox" checked={picked.includes(p)} onChange={() => toggle(p)} />
                  <span className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[p].color, mode) }} />
                  {PROGRAM_BY_KEY[p].short}
                </label>
              ))}
              {g.id === 'other' && (
                <label className="field entity-pick">
                  Single entity
                  <select value={entity ?? ''} onChange={(e) => setQuery({ ent: e.target.value || null })}>
                    <option value="">None</option>
                    {entities.map(([name, n]) => (
                      <option key={name} value={name}>{name} ({fmt(n)})</option>
                    ))}
                  </select>
                </label>
              )}
            </fieldset>
          ))}
        </div>
        <div className="controls">
          <label className="field">
            Metric
            <select value={metric} onChange={(e) => setQuery({ m: e.target.value === 'perM' ? null : e.target.value })}>
              {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label className="field">
            Counting
            <select value={measure} onChange={(e) => setQuery({ num: e.target.value === 'crashes' ? null : e.target.value })}>
              {MEASURES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <div className="field">
            Grain
            <div className="seg" role="group" aria-label="Time grain">
              <button type="button" className={grain === 'year' ? 'on' : ''} aria-pressed={grain === 'year'} onClick={() => setQuery({ g: null })}>Annual 2019-{lastYear}</button>
              <button type="button" className={grain === 'month' ? 'on' : ''} aria-pressed={grain === 'month'} onClick={() => setQuery({ g: 'm' })}>Monthly</button>
            </div>
          </div>
          {grain === 'month' && (
            <label className="field">
              Year
              <select value={year} onChange={(e) => setQuery({ y: Number(e.target.value) === lastYear ? null : e.target.value })}>
                {Array.from({ length: lastYear - 2021 + 1 }, (_, i) => lastYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
          )}
          {computed.filter((c) => c.regions.length > 1).map((c) => (
            <label className="field" key={c.prog}>
              Region: {c.short}
              <select value={c.region} onChange={(e) => setQuery({ ['rg_' + c.prog]: e.target.value })}>
                {c.regions.map((r) => <option key={r} value={r}>{regionLabel(r)}</option>)}
              </select>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={showEvents} onChange={(e) => setQuery({ ev: e.target.checked ? null : '0' })} />
            Show events (launches, recalls, suspensions)
          </label>
        </div>

        {computed.length === 0 && <p className="callout">Pick at least one program above.</p>}

        {computed.length > 0 && (
          <>
            {/* ---- chart ---- */}
            <figure className="panel rates-chart">
              <figcaption>
                <span className="panel-title">
                  {info.label}, {measure === 'crashes' ? 'all crashes' : MEASURES.find((m) => m.id === measure)!.label.toLowerCase()}
                  {anyScenario && <> <ScenarioBadge /></>}
                </span>
                <span className="panel-total">
                  {grain === 'year' ? `Annual, 2019 to ${lastYear}` : `Monthly, ${year}`} · bands: exact Poisson 95% interval · right axis: exposure behind the rate
                  <SourceBadge sourceIds={allSourceIds} label="All sources for this chart" />
                </span>
              </figcaption>
              <DualAxisChart
                series={chartSeries} grain={grain} firstYear={2019} lastYear={lastYear} year={year}
                metricAxis={info.axis} volumeUnit={volumeUnit} events={events} mode={mode} ariaLabel={chartSummary}
              />
              <ul className="legend rates-legend">
                {computed.map((c) => (
                  <li key={c.prog}><span className="swatch" style={{ background: c.color }} /> {c.short}: {regionLabel(c.region)}</li>
                ))}
                <li>Left axis: {info.axis}. Right axis: exposure ({volumeUnit === 'miles' ? 'miles' : 'active vehicles'}).</li>
                <li><span className="mk mk-fill" /> filled marker: enough crashes, exposure reported or derived</li>
                <li><span className="mk mk-hollow" /> hollow marker, hatched band: low sample or estimated exposure</li>
                <li><span className="mk mk-break" /> dashed line: 2025-06-16 NHTSA rule change (not a safety change)</li>
                <li><span className="flag-icon" aria-hidden="true">⚑</span> flag: that month's exposure was split from very uneven disclosures (&gt;3×), so its rate is unreliable (hover the month for the note)</li>
                <li><span className="mk mk-area" /> shaded columns: exposure (right axis)</li>
              </ul>
              {grain === 'month' && year > 2025 && (
                <p className="small">The 2025-06-16 rule change lies before this range: every month shown follows the Third Amended SGO.</p>
              )}
              {grain === 'year' && <p className="small">2019 and 2020 are empty: SGO reporting began 2021-07, and 2021 covers July to December only.</p>}
              {anyLow && <p className="small"><LowSampleMark /> Some points are low-sample or rest on an estimate; read them as rough.</p>}
              {volumeUnit === 'vehicles' && needs === 'none' && <p className="small">Right axis shows active vehicles where no miles are disclosed.</p>}
              {events && events.length > 0 && <EventList events={events} />}
            </figure>

            {/* ---- why no data ---- */}
            <div className="callout why-no-data">
              <h3>What the denominators are, and why some points are missing</h3>
              {reasons.map(({ c, list, more }) => (
                <div key={c.prog}>
                  <p className="small">
                    {WHY[c.prog] ?? (c.prog.startsWith('entity:') ? `${c.short}: no exposure data is collected for single entities; only counts are available.` : '')}{' '}
                    Crashes are matched to <b>{regionLabel(c.region)}</b>
                    {c.region === 'north_america' && ' (the miles include Canada; crashes are US reports)'}
                    {c.region.startsWith('city:') && ' by the NHTSA city field (metro areas are approximate)'}.
                  </p>
                  {list.length > 0 && (
                    <ul className="small">
                      {list.map(([r, n]) => <li key={r}>{r} ({n} period{n > 1 ? 's' : ''})</li>)}
                      {more > 0 && <li>and {more} more reason(s); see the table.</li>}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            {/* ---- table ---- */}
            <h3>Every point in the chart</h3>
            <div className="table-actions">
              <button type="button" className="btn" onClick={downloadCsv}>Download CSV</button>
              <span className="small">{tableRows.length} rows, including periods with no rate and the reason.</span>
            </div>
            <div className="table-wrap">
              <table className="rates-table">
                <caption className="sr-only">Rates by program and period</caption>
                <thead>
                  <tr>
                    <th scope="col">Program</th>
                    <th scope="col">Period</th>
                    <th scope="col" className="num">Crashes</th>
                    <th scope="col" className="num">Exposure</th>
                    <th scope="col">Kind</th>
                    <th scope="col" className="num">{info.short}</th>
                    <th scope="col">95% interval</th>
                    <th scope="col">Flags</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(({ c, p }) => (
                    <tr key={c.prog + p.period} className={p.rate == null && !p.lowerBound ? 'nodata' : ''}>
                      <td><span className="swatch" style={{ background: c.color }} /> {c.short}</td>
                      <td>{p.period}{p.flag && <> <FlagNote note={p.flag} period={p.period} /></>}</td>
                      <td className="num">{fmtInt(p.k)}{p.kAdj !== p.k && <span className="small"> ({fmtNum(p.kAdj)} adj.)</span>}</td>
                      <td className="num">{p.exposure != null ? `${fmtNum(p.exposure)} ${p.volumeUnit}` : p.volume != null ? <span className="small">{fmtNum(p.volume)} {p.volumeUnit} (not a denominator)</span> : 'none'}</td>
                      <td>{p.exposureKind ?? ''}</td>
                      <td className="num"><b>{p.rate == null && !p.lowerBound ? 'no data' : fmtRateText(p)}</b></td>
                      <td>{p.rate == null && !p.lowerBound ? <span className="small">{p.reason}</span> : fmtCI(p)}</td>
                      <td>
                        {p.lowSample && p.rate != null && <LowSampleMark />}
                        {p.scenario && <ScenarioBadge />}
                        {p.partial && p.volume != null && <span className="small"> {p.months.length} month(s)</span>}
                        {p.lowerBound && <span className="small"> {p.reason}</span>}
                      </td>
                      <td><SourceBadge sourceIds={p.sourceIds} kind={p.exposureKind} method={p.method} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- funnel ---- */}
            <h3>Funnel plot: is a difference more than chance?</h3>
            <p className="prose small">
              Each point is one program-year (2021 on). The line is the pooled rate of the points shown; the funnels are the 95% (solid) and 99.8% (dashed) limits that
              chance alone would produce at each volume. Small programs sit far to the left where the funnel is wide; a point outside it is a real difference in this
              data, not necessarily a real difference in safety (different roads, vehicles and reporting). Hollow markers are low sample or estimated exposure.
            </p>
            {funnel.pts.length >= 2 ? (
              <figure className="panel">
                <div className="controls">
                  <label className="field">
                    Reference rate (centre line)
                    <select value={refProg} onChange={(e) => setQuery({ ref: e.target.value || null })}>
                      <option value="">Pooled over all points shown</option>
                      {[...new Set(funnel.pts.map((p) => p.program))].map((k) => (
                        <option key={k} value={k}>{funnel.pts.find((p) => p.program === k)!.label} only</option>
                      ))}
                    </select>
                  </label>
                  <p className="small" style={{ maxWidth: '60ch', margin: 0 }}>
                    Pooling driver-assist and driverless programs, or programs whose volumes differ a hundredfold, puts most points outside the funnel by construction.
                    Pick one program as the reference to ask which others differ from it. Each program uses the region selected above.
                  </p>
                </div>
                <FunnelPlot
                  points={funnel.pts} factor={funnelFactor} mode={mode} refProgram={refProg}
                  rateLabel={funnelMetric === 'per10kVeh' ? 'crashes per 10,000 vehicles' : funnelMetric === 'per1k' ? 'crashes per 1,000 miles' : 'crashes per million miles'}
                  exposureLabel={funnelMetric === 'per10kVeh' ? 'vehicles' : 'miles'}
                />
                {funnel.skipped.length > 0 && <p className="small">Not shown (no disclosed denominator at annual grain; miles that only come from an assumed miles per vehicle are never compared): {funnel.skipped.join(', ')}.</p>}
              </figure>
            ) : (
              <p className="callout small">Select two or more programs with annual exposure (for example Waymo and GM Super Cruise) to compare them on a funnel plot.</p>
            )}

            {computed.some((c) => c.prog === 'tesla_l2') && <TeslaVsrPanel rows={rates.company} mode={mode} />}
          </>
        )}

        <ScenarioPanel
          scenario={scenario} update={updateScenario} reset={resetScenario} mpvPrograms={mpvPrograms}
          teslaSelected={computed.some((c) => c.prog === 'tesla_l2')}
        />

        <h3>Where the data is thin</h3>
        <p className="prose small">
          Each cell is the national (US or North America) exposure disclosure for that program and year: <b>rep</b> reported, <b>der</b> derived from reported
          figures, <b>est</b> estimate, <b>region</b> only a California, city or worldwide series (never used as a US denominator), <b>none</b> nothing disclosed.
        </p>
        <CoverageMatrix exposure={rates.exposure} lastYear={lastYear} />
      </section>
    </SourcesCtx.Provider>
  );
}

function EventList({ events }: { events: RatesData['events'] }) {
  return (
    <details className="event-list">
      <summary>{events.length} events marked as dotted lines</summary>
      <ul className="small">
        {[...events].sort((a, b) => a.date.localeCompare(b.date)).map((e) => (
          <li key={e.date + e.label}>
            <b>{e.date}</b> ({e.type}) {e.label}
          </li>
        ))}
      </ul>
    </details>
  );
}
