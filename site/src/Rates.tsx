import { useMemo } from 'react';
import type { Data } from './data';
import { fmt } from './data';
import { PROGRAM_BY_KEY, colorOf, type Mode } from './theme';
import { excludedByMonth, regionLabel, regionRateBlock, scopedCounts, sumExcluded, useRatesData, type RatesData } from './data/rates';
import { INCOMPLETE_LABEL, metricNeeds, regionsFor, series, type Grain, type Measure, type Metric, type Point } from './lib/metrics';
import { KIND_CAVEAT, KIND_GROUPS, kindLabel, kindOf, limitToKind, singleKindItems, toggleWithinKind, type KindId } from './lib/kinds';
import { MILES_ONLY_LABEL, isMilesOnlyRegion, isRiderOnlyProgram } from './lib/scope';
import { METRICS, csvCell, fmtCI, fmtInt, fmtNum, fmtRateText, metricInfo } from './lib/format';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { DualAxisChart, type ChartSeries } from './components/DualAxisChart';
import { FunnelPlot, type FunnelPoint } from './components/FunnelPlot';
import { ScenarioPanel } from './components/ScenarioPanel';
import { CoverageMatrix } from './components/CoverageMatrix';
import { TeslaVsrPanel } from './components/TeslaVsrPanel';
import { FlagNote, IncompleteMark } from './components/FlagNote';
import { KindCaveat } from './components/KindCaveat';
import { LowSampleMark, ScenarioBadge, SourceBadge, SourcesCtx } from './components/SourceBadge';
import { SourceNote } from './EChart';
import { ALL_LABEL, ROBUST_LABEL, RegimeBadge, RobustNote } from './components/Regime';

const ALL_PROGRAMS = KIND_GROUPS.flatMap((g) => g.programs);
const MEASURES: { id: Measure; label: string }[] = [
  { id: 'robust', label: ROBUST_LABEL },
  { id: 'crashes', label: ALL_LABEL },
  { id: 'injury', label: 'Any injury' },
  { id: 'serious_plus', label: 'Serious or fatal injury' },
  { id: 'fatal', label: 'Fatal' },
  { id: 'vru', label: 'Pedestrian / cyclist' },
];

const WHY: Record<string, string> = {
  tesla_l2:
    'Tesla Autopilot/FSD (Level 2): per-mile rates use North America FSD (Supervised) miles from Tesla\'s FSD safety report (rolling 12-month totals from 2024-10, split by month along Tesla\'s mileage counter): estimates. NHTSA counts cannot be split between Autopilot and FSD, and Autopilot miles are not disclosed, so the rate is high for FSD alone; the miles include Canada. Per-vehicle rates use US vehicle counts quoted in NHTSA investigations (estimates whose definition changes over the years).',
  tesla_robotaxi:
    'Tesla Robotaxi (ADS): one disclosed counter (3.1 M miles to 2026-10-18), spread evenly from the 2025-06-22 Austin launch, so monthly miles are rough estimates; Tesla does not say whether rides with a safety driver are included. Fleet figures are small estimates.',
  gm_supercruise:
    'GM Super Cruise (Level 2): North America miles are estimates interpolated between GM and Trimble disclosures (2022-10 to 2026-10; they include Canada), and vehicle counts are only reported for 2026. Two disclosures do not reconcile (800 M in March 2026, 1 B in April 2026), so those months are flagged. Crashes are all US reports, so read these rates as rough.',
  gm_cruise_ads:
    'GM Cruise (ADS): US miles are estimates for 2023-03 to 2023-09 only; the numerator counts only crashes with no in-vehicle operator, to match driverless miles. The California DMV miles are testing miles (including safety drivers) and are shown for information only, never as a denominator. Cruise suspended driverless operations in October 2023 and was wound down in December 2024.',
  waymo_ads:
    'Waymo (ADS): US rider-only miles (no human driver) from Waymo disclosures: 1 M in January 2023, 7.14 M to October 2023 (Waymo\'s crash-rate study), then the Waymo Safety Impact hub from 2024-06; monthly values are interpolated between these dates, so most are estimates. The numerator counts only crashes with no in-vehicle operator, to match rider-only miles. California DMV testing miles are shown for information only, never as a denominator.',
  zoox_ads:
    'Zoox (ADS): only California DMV testing miles (testing with safety drivers, Dec-Nov years) and a small fleet estimate are available. The California miles are not a denominator for SGO crashes, so there is no rate; there are no US miles.',
  other_ads: 'Other reporters (ADS): no exposure data is collected; only counts are available.',
  other_l2: 'Other reporters (Level 2): no exposure data is collected; only counts are available.',
};

/** The default exposure region for a rate: a national or city region with data, never miles-only (California DMV) or worldwide. */
export function defaultRegion(rates: RatesData, program: string, metric: Metric): string {
  if (program.startsWith('entity:')) return 'us';
  const regs = regionsFor(rates.exposure, program);
  const has = (r: string, m: string) => rates.exposure.some((x) => x.program === program && x.region === r && x.metric === m);
  const order = regs.filter((r) => regionRateBlock(r) == null);
  const need = metricNeeds(metric) === 'vehicles' ? ['active_vehicles'] : ['miles', 'active_vehicles'];
  for (const m of need) {
    const r = order.find((x) => has(x, m));
    if (r) return r;
  }
  return order[0] ?? 'us';
}

type Computed = {
  prog: string;
  label: string;
  short: string;
  color: string;
  region: string;
  regions: string[];
  points: Point[];
  kind: KindId | null;
  /** Crashes left out to match rider-only miles, over the periods that are drawn (null when the filter does not apply). */
  excluded: { in_vehicle: number; other: number } | null;
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
  const entities = useMemo(() => {
    // Program-level records: an entity counts once per (program, incident) it filed in. Its kind is the kind of most of its records.
    const c = new Map<string, { n: number; kinds: Record<KindId, number> }>();
    for (const x of data.crashes) {
      const k = kindOf(x.program);
      for (const name of x.entities) {
        const e = c.get(name) ?? { n: 0, kinds: { ads: 0, l2: 0 } };
        e.n++;
        if (k) e.kinds[k]++;
        c.set(name, e);
      }
    }
    return [...c.entries()]
      .map(([name, e]) => ({ name, n: e.n, kind: (e.kinds.ads >= e.kinds.l2 ? 'ads' : 'l2') as KindId }))
      .sort((a, b) => b.n - a.n);
  }, [data.crashes]);

  // ---- view state (URL) ----
  // One kind group at a time: L2 and ADS reporting thresholds differ, so they never share a chart, table or funnel.
  const rawPicked = (params.get('p') ?? 'waymo_ads,gm_cruise_ads,tesla_robotaxi').split(',').filter((p) => ALL_PROGRAMS.includes(p));
  const picked = limitToKind(rawPicked);
  const rawEntity = params.get('ent');
  const entityInfo = entities.find((e) => e.name === rawEntity);
  const pageKind: KindId | null = picked.length ? kindOf(picked[0]) : entityInfo?.kind ?? null;
  const entity = entityInfo && (pageKind == null || entityInfo.kind === pageKind) ? entityInfo.name : null;
  const entityDropped = rawEntity != null && entity == null;
  const metric = (METRICS.find((m) => m.id === params.get('m'))?.id ?? 'perM') as Metric;
  const grain: Grain = params.get('g') === 'm' ? 'month' : 'year';
  const year = Math.min(lastYear, Math.max(2021, Number(params.get('y')) || lastYear));
  const showEvents = params.get('ev') !== '0';
  // Default numerator: threshold-robust crashes (comparable across the 2025-06-16 rule change).
  const measure = (MEASURES.find((m) => m.id === params.get('num'))?.id ?? 'robust') as Measure;
  const refProg = params.get('ref') ?? '';
  const keys = [...picked, ...(entity ? [`entity:${entity}`] : [])];

  const setPicked = (list: string[]) => setQuery({ p: list.length ? list.join(',') : 'none', ref: null });
  const toggle = (p: string) => {
    const next = toggleWithinKind(picked, p);
    const switched = next.length > 0 && pageKind != null && kindOf(next[0]) !== pageKind;
    setQuery({ p: next.length ? next.join(',') : 'none', ref: null, ...(switched ? { ent: null } : {}) });
  };
  const pickEntity = (name: string) => {
    const e = entities.find((x) => x.name === name);
    // An entity of the other kind replaces the program selection instead of mixing with it.
    setQuery({ ent: name || null, ...(e && pageKind != null && e.kind !== pageKind ? { p: 'none' } : {}) });
  };

  // ---- computation ----
  const computed: Computed[] = useMemo(
    () =>
      keys.map((prog) => {
        const isEntity = prog.startsWith('entity:');
        const info = PROGRAM_BY_KEY[isEntity ? 'other_ads' : prog];
        const kind = isEntity ? entityInfo?.kind ?? null : kindOf(prog);
        const regions = isEntity ? ['us'] : regionsFor(rates.exposure, prog);
        const region = params.get('rg_' + prog) ?? defaultRegion(rates, prog, metric);
        const regionList = regions.includes(region) ? regions : [region, ...regions];
        const block = regionRateBlock(region);
        const counts = block === 'global' ? scopedCounts(rates.countRows, data.crashes, prog, 'us', { riderOnly: scenario.riderOnly }) : scopedCounts(rates.countRows, data.crashes, prog, region, { riderOnly: scenario.riderOnly });
        const points = series(counts, rates.exposure, scenario, {
          program: prog, region, metric, grain, year, firstYear: 2019, lastMonth: rates.lastMonth, measure, lag: rates.lag[prog],
        });
        let excluded: Computed['excluded'] = null;
        if (!isEntity && scenario.riderOnly && isRiderOnlyProgram(prog) && counts != null) {
          const months = points.filter((p) => p.rate != null).flatMap((p) => p.months);
          excluded = sumExcluded(excludedByMonth(data.crashes, prog, block === 'global' ? 'us' : region), months);
        }
        return {
          prog, region, regions: regionList, points, kind, excluded,
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
    // The pooled reference only ever spans one kind group (the page selection already holds one kind; this keeps it so).
    const sameKind = singleKindItems(computed.map((c) => ({ c, kind: c.kind }))).map((x) => x.c);
    for (const c of sameKind) {
      const block = regionRateBlock(c.region);
      const counts = scopedCounts(rates.countRows, data.crashes, c.prog, block === 'global' ? 'us' : c.region, { riderOnly: scenario.riderOnly });
      const ps = series(counts, rates.exposure, scenario, {
        program: c.prog, region: c.region, metric: funnelMetric, grain: 'year', firstYear: 2021, lastMonth: rates.lastMonth, measure, lag: rates.lag[c.prog],
      });
      let n = 0;
      for (const p of ps)
        if (p.rate != null && p.exposure != null && p.exposure > 0 && !p.notes.some((n) => /assumed miles per vehicle/.test(n))) {
          n++;
          pts.push({ program: c.prog, label: c.short, color: c.color, period: p.period, rate: p.rate, exposure: p.exposure, k: p.k, lowSample: p.lowSample, scenario: p.scenario, kind: c.kind, incomplete: p.incomplete.length > 0 });
        }
      if (n === 0) skipped.push(c.short);
    }
    return { pts, skipped };
  }, [computed, rates, data.crashes, scenario, funnelMetric, measure]);

  // ---- table + CSV ----
  const tableRows = computed.flatMap((c) => c.points.map((p) => ({ c, p })));
  const downloadCsv = () => {
    const head = ['program', 'region', 'metric', 'numerator', 'period', 'rules', 'crashes_raw', 'crashes_adjusted', 'exposure', 'exposure_unit', 'exposure_kind', 'rate', 'ci95_lo', 'ci95_hi', 'low_sample', 'scenario', 'partial_period', 'months_used', 'incomplete_months', 'rider_only_numerator', 'reason', 'source_ids', 'method'];
    const lines = [head.join(',')];
    for (const { c, p } of tableRows)
      lines.push(
        [c.prog, c.region, metric, measure, p.period, regimeText(p.period), p.k, p.kAdj, p.exposure ?? '', p.exposure != null ? p.exposureUnit : '', p.exposureKind ?? '', p.rate ?? '', p.lo ?? '', p.hi ?? '', p.lowSample, p.scenario, p.partial, p.months.length, p.incomplete.join(';'), c.excluded != null, p.reason ?? '', p.sourceIds.join(';'), p.method]
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

  const milesOnlyShown = computed.filter((c) => regionRateBlock(c.region) === 'miles-only');
  const unmappedShown = computed.filter((c) => regionRateBlock(c.region) === 'unmapped');
  const anyIncomplete = computed.some((c) => c.points.some((p) => p.incomplete.length > 0));
  const excludedNotes = computed.filter((c) => c.excluded && c.excluded.in_vehicle + c.excluded.other > 0);
  const volumeNote = milesOnlyShown.length === computed.length && computed.length > 0 ? 'informational: CA DMV testing miles' : undefined;
  const infoRows = useMemo(
    () => rates.exposure.filter((r) => isMilesOnlyRegion(r.region) && r.metric === 'miles' && computed.some((c) => c.prog === r.program)),
    [rates.exposure, computed],
  );

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="rates">
        <h2>Rates, with their uncertainty</h2>
        <p className="prose">
          Crashes divided by exposure (miles or vehicle-years), only where a sourced denominator exists for the <em>same</em> region and months. Every rate shows an
          exact Poisson 95% interval. Hatched bands and hollow markers mean a low sample (fewer than 10 crashes) or an estimated denominator. Where no denominator exists,
          the chart says so instead of drawing a zero.
        </p>
        <KindCaveat extra="So this page shows one kind at a time: picking a program of the other kind replaces the selection." />

        {/* ---- controls ---- */}
        <div className="rates-controls">
          {KIND_GROUPS.map((g) => (
            <fieldset className={`prog-group kind-${g.id}`} key={g.id}>
              <legend>{g.label}</legend>
              {g.programs.map((p) => (
                <label className="prog-chip" key={p}>
                  <input type="checkbox" checked={picked.includes(p)} onChange={() => toggle(p)} />
                  <span className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[p].color, mode) }} />
                  {PROGRAM_BY_KEY[p].short}
                </label>
              ))}
            </fieldset>
          ))}
          <fieldset className="prog-group">
            <legend>One reporting entity</legend>
            <label className="field entity-pick">
              <span className="sr-only">Single reporting entity</span>
              <select value={entity ?? ''} onChange={(e) => pickEntity(e.target.value)} aria-label="Single reporting entity">
                <option value="">None</option>
                {entities.map((e) => (
                  <option key={e.name} value={e.name}>{e.name} ({fmt(e.n)}, {KIND_GROUPS.find((g) => g.id === e.kind)!.short})</option>
                ))}
              </select>
            </label>
          </fieldset>
        </div>
        {entityDropped && <p className="small-block">The entity in the address belongs to the other kind group, so it is not drawn with the selected programs.</p>}
        <div className="controls">
          <label className="field">
            Metric
            <select value={metric} onChange={(e) => setQuery({ m: e.target.value === 'perM' ? null : e.target.value })}>
              {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label className="field">
            Counting
            <select value={measure} onChange={(e) => setQuery({ num: e.target.value === 'robust' ? null : e.target.value })}>
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
                {c.regions.map((r) => {
                  const block = regionRateBlock(r);
                  const milesOnly = block === 'miles-only';
                  return (
                    <option key={r} value={r} disabled={milesOnly && metric !== 'count'}>
                      {regionLabel(r)}{block === 'unmapped' ? ' (region not mapped: no rate)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={showEvents} onChange={(e) => setQuery({ ev: e.target.checked ? null : '0' })} />
            Show events (launches, recalls, suspensions)
          </label>
        </div>

        {computed.length === 0 && <p className="callout">Pick at least one program above.</p>}

        {unmappedShown.map((c) => (
          <p key={c.prog} className="callout health-warn small" role="alert">
            <b>Data health warning:</b> the exposure region <span className="mono">{c.region}</span> for {c.short} has no crash scope defined, so no rate is computed (shown as no rate, never 0).
            Add the region to the city map before publishing a rate for it.
          </p>
        ))}
        {milesOnlyShown.length > 0 && metric !== 'count' && (
          <p className="callout health-warn small" role="note">
            <b>No comparable denominator.</b> {milesOnlyShown.map((c) => c.short).join(', ')}: the California exposure is {MILES_ONLY_LABEL}. It is drawn on the right axis for information only; no rate is computed from it.
          </p>
        )}

        {computed.length > 0 && (
          <>
            {/* ---- chart ---- */}
            <figure className="panel rates-chart">
              <figcaption>
                <span className="panel-title">
                  {info.label}, {measure === 'robust' ? 'threshold-robust crashes' : measure === 'crashes' ? 'all reportable crashes' : MEASURES.find((m) => m.id === measure)!.label.toLowerCase()} · {pageKind ? kindLabel(pageKind) : 'selected reporter'}
                  {anyScenario && <> <ScenarioBadge label={computed.some((c) => c.points.some((p) => p.assumption)) ? 'your assumption' : undefined} /></>}
                </span>
                <span className="panel-total">
                  {grain === 'year' ? `Annual, 2019 to ${lastYear}` : `Monthly, ${year}`} · bands: exact Poisson 95% interval · right axis: exposure behind the rate
                  <SourceBadge sourceIds={allSourceIds} label="All sources for this chart" />
                </span>
                <span className="panel-total"><RegimeBadge robust={measure === 'robust'} /></span>
              </figcaption>
              <DualAxisChart
                series={chartSeries} grain={grain} firstYear={2019} lastYear={lastYear} year={year}
                metricAxis={info.axis} volumeUnit={volumeUnit} volumeNote={volumeNote} events={events} mode={mode} ariaLabel={chartSummary}
              />
              <ul className="legend rates-legend">
                {computed.map((c) => (
                  <li key={c.prog}><span className="swatch" style={{ background: c.color }} /> {c.short}: {regionLabel(c.region)}</li>
                ))}
                <li>Left axis: {info.axis}. Right axis: exposure ({volumeUnit === 'miles' ? 'miles' : 'active vehicles'}).</li>
                <li><span className="mk mk-fill" /> filled marker: enough crashes, exposure reported or derived</li>
                <li><span className="mk mk-hollow" /> hollow marker, hatched band: low sample or estimated exposure</li>
                <li><span className="mk mk-break" /> dashed line: 2025-06-16 NHTSA rule change (not a safety change); the line is not joined across it</li>
                <li><span className="mk-late" /> <span className="mk-late-col" /> dotted line, hatched column: {INCOMPLETE_LABEL}</li>
                <li><span className="flag-icon" aria-hidden="true">⚑</span> flag: that month's exposure was split from very uneven disclosures (&gt;3×), so its rate is unreliable (hover the month for the note)</li>
                <li><span className="mk mk-area" /> shaded columns: exposure (right axis)</li>
              </ul>
              {grain === 'month' && year > 2025 && (
                <p className="small">The 2025-06-16 rule change lies before this range: every month shown follows the Third Amended SGO.</p>
              )}
              {grain === 'year' && <p className="small">2019 and 2020 are empty: SGO reporting began 2021-07, and 2021 covers July to December only. 2025 spans the 2025-06-16 rule change, so it stands alone (not joined to 2024 or 2026); for a before/after reading see <a href="#improving">Before / after</a>.</p>}
              {measure === 'robust' ? <RobustNote kind={pageKind} /> : measure === 'crashes' ? <p className="small" role="note"><b>All reportable crashes:</b> the reporting threshold changed on 2025-06-16, so this count drops at that date whatever happened on the road. Switch Counting back to threshold-robust crashes to compare across it.</p> : null}
              {anyIncomplete && <p className="small"><IncompleteMark months={[...new Set(computed.flatMap((c) => c.points.flatMap((p) => p.incomplete)))].sort()} /> Recent months are incomplete (late reports expected): hatched columns and dotted lines mark them, so a dip there is not an improvement. Turn on the late-report adjustment in the scenario panel to see an adjusted estimate.</p>}
              {metric === 'per10kVeh' && <p className="small">Per-vehicle rates are crashes per 10,000 vehicle-years: vehicles x (months covered / 12), with the crashes counted over the same months. A partial year is flagged and not read as safer than a full one.</p>}
              {anyLow && <p className="small"><LowSampleMark /> Some points are low-sample or rest on an estimate; read them as rough.</p>}
              {volumeUnit === 'vehicles' && needs === 'none' && <p className="small">Right axis shows active vehicles where no miles are disclosed.</p>}
              {excludedNotes.map((c) => (
                <p key={c.prog} className="small" role="note">
                  <b>{c.short}:</b> {c.excluded!.in_vehicle + c.excluded!.other} crashes with an in-vehicle operator excluded to match rider-only miles
                  ({c.excluded!.in_vehicle} with an in-vehicle operator{c.excluded!.other > 0 ? `, ${c.excluded!.other} with another or unknown operator type` : ''}), over the periods drawn. Switch the rider-only numerator off in the scenario panel to count them.
                </p>
              ))}
              {!scenario.riderOnly && computed.some((c) => isRiderOnlyProgram(c.prog)) && (
                <p className="small" role="note"><b>Rider-only numerator is off:</b> crashes with an in-vehicle operator are counted against rider-only miles, which overstates the rate.</p>
              )}
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
                    <th scope="col">Rules</th>
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
                      <td className="small">{regimeText(p.period)}</td>
                      <td className="num">{fmtInt(p.k)}{p.kAdj !== p.k && <span className="small"> ({fmtNum(p.kAdj)} adj.)</span>}</td>
                      <td className="num">{p.exposure != null ? `${fmtNum(p.exposure)} ${p.exposureUnit}` : p.volume != null ? <span className="small">{fmtNum(p.volume)} {p.volumeUnit}{regionRateBlock(c.region) === 'miles-only' ? ' (CA DMV testing, not a denominator)' : ' (not a denominator)'}</span> : 'none'}</td>
                      <td>{p.exposureKind ?? ''}</td>
                      <td className="num"><b>{p.rate == null && !p.lowerBound ? 'no data' : fmtRateText(p)}</b></td>
                      <td>{p.rate == null && !p.lowerBound ? <span className="small">{p.reason}</span> : fmtCI(p)}</td>
                      <td>
                        {p.lowSample && p.rate != null && <LowSampleMark />}
                        {p.scenario && <ScenarioBadge label={p.assumption ? 'your assumption' : undefined} title={p.assumption ? 'The denominator is built from an assumption you set in the scenario panel, not from a disclosure' : undefined} />}
                        {p.incomplete.length > 0 && p.k > 0 && <IncompleteMark months={p.incomplete} />}
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
              Each point is one program-year (2021 on) of the one kind group selected above. The line is the pooled rate of the points shown; the funnels are the 95% (solid) and 99.8% (dashed) limits that
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
                    The pooled rate spans one kind group only ({pageKind ? kindLabel(pageKind) : 'the selected kind'}); Level 2 and ADS programs are never pooled, because their reporting thresholds differ.
                    Programs whose volumes differ a hundredfold still put most points outside the funnel by construction: pick one program as the reference to ask which others differ from it. Each program uses the region selected above.
                  </p>
                </div>
                <FunnelPlot
                  points={funnel.pts} factor={funnelFactor} mode={mode} refProgram={refProg}
                  rateLabel={funnelMetric === 'per10kVeh' ? 'crashes per 10,000 vehicle-years' : funnelMetric === 'per1k' ? 'crashes per 1,000 miles' : 'crashes per million miles'}
                  exposureLabel={funnelMetric === 'per10kVeh' ? 'vehicle-years' : 'miles'}
                />
                {funnel.skipped.length > 0 && <p className="small">Not shown (no disclosed denominator at annual grain; miles that only come from an assumed miles per vehicle are never compared): {funnel.skipped.join(', ')}.</p>}
              </figure>
            ) : (
              <p className="callout small">Select two or more programs of one kind with annual exposure (for example Waymo and GM Cruise) to compare them on a funnel plot.</p>
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
          figures, <b>est</b> estimate, <b>region</b> only a city or worldwide series (never used as a US denominator), <b>none</b> nothing disclosed.
          The <b>CA DMV</b> rows hold California DMV autonomous-testing miles (Dec-Nov reporting years, testing miles including safety drivers): informational only,
          not comparable with SGO crashes, never a denominator.
        </p>
        <CoverageMatrix exposure={rates.exposure} lastYear={lastYear} />
        {infoRows.length > 0 && (
          <p className="small-block">
            Informational series for the programs shown ({MILES_ONLY_LABEL}):{' '}
            {infoRows.map((r) => `${PROGRAM_BY_KEY[r.program]?.short ?? r.program} ${r.period} ${fmtNum(r.value)} miles`).join('; ')}.
          </p>
        )}
        <SourceNote date={data.meta.fetched_date} extra="Numerators: NHTSA SGO crashes, one record per program and incident, by incident month. Denominators: company disclosures (see each point's source badge)." />
      </section>
    </SourcesCtx.Provider>
  );
}

/** Which reporting rules a period falls under: before, spanning or after the 2025-06-16 change. */
function regimeText(period: string): string {
  if (period.length === 4) return period < '2025' ? 'before' : period === '2025' ? 'spans the change' : 'after';
  return period < '2025-06' ? 'before' : period === '2025-06' ? 'mixed month' : 'after';
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
