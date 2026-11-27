import { useMemo } from 'react';
import type { Data } from './data';
import { fmt } from './data';
import { PROGRAM_BY_KEY, PROGRAMS, colorOf, ui, type Mode } from './theme';
import { excludedByMonth, regionRateBlock, scopedCounts, sumExcluded, useRatesData, type RatesData } from './data/rates';
import { isRiderOnlyProgram } from './lib/scope';
import { KIND_GROUPS, kindOf } from './lib/kinds';
import { KindCaveat } from './components/KindCaveat';
import { IncompleteMark } from './components/FlagNote';
import { CITY_REGION_BY_KEY, pool, rankCities, unmatchedCities, type Pooled } from './lib/cities';
import { learningCurve, monthlyPoints } from './lib/learning';
import { fmtNum } from './lib/format';
import { dateMs } from './lib/timeline';
import type { Point } from './lib/metrics';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { RateBars, type BarItem } from './components/RateBars';
import { Spark, type SparkPt } from './components/Spark';
import { LowSampleMark, ScenarioBadge, SourceBadge, SourcesCtx } from './components/SourceBadge';
import { SourceNote } from './EChart';

export function Cities({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the rates data files ({error}).</p>;
  if (!rates) return <p className="loading">Loading exposure and count data…</p>;
  return <CitiesLoaded data={data} rates={rates} mode={mode} />;
}

type Row = {
  region: string;
  label: string;
  pooled: Pooled | null;
  monthly: Point[];
  quarters: SparkPt[];
  /** The region has no crash scope: no rate, with a data-health warning. */
  unmapped: boolean;
  excluded: { in_vehicle: number; other: number } | null;
};

function CitiesLoaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario] = useScenario();
  const t = ui(mode);

  // Programs with per-city MILES (a city fleet count is not a mileage denominator).
  const cityPrograms = useMemo(
    () => [...new Set(rates.exposure.filter((r) => r.region.startsWith('city:') && r.metric === 'miles').map((r) => r.program))],
    [rates],
  );
  const prog = cityPrograms.includes(params.get('cpg') ?? '') ? (params.get('cpg') as string) : cityPrograms[0] ?? 'waymo_ads';
  const info = PROGRAM_BY_KEY[prog];
  const color = colorOf(info.color, mode);

  const regions = useMemo(
    () => [...new Set(rates.exposure.filter((r) => r.program === prog && r.region.startsWith('city:') && r.metric === 'miles').map((r) => r.region))],
    [rates, prog],
  );
  const years = useMemo(() => {
    const ys = new Set<string>();
    for (const r of rates.exposure) if (r.program === prog && r.region.startsWith('city:') && r.metric === 'miles') ys.add(r.period.slice(0, 4));
    return [...ys].sort();
  }, [rates, prog]);
  const period = years.includes(params.get('cpd') ?? '') ? (params.get('cpd') as string) : 'all';

  const rows: Row[] = useMemo(
    () =>
      regions.map((region) => {
        const counts = scopedCounts(rates.countRows, data.crashes, prog, region, { riderOnly: scenario.riderOnly });
        const monthly = monthlyPoints(counts, rates.exposure, scenario, { program: prog, region, lastMonth: rates.lastMonth, lag: rates.lag[prog] });
        const inPeriod = period === 'all' ? monthly : monthly.filter((p) => p.period.startsWith(period));
        const quarters = learningCurve(monthly, { group: 'quarter', lastMonth: rates.lastMonth, lag: rates.lag[prog] }).map((q) => ({
          period: q.period, t: dateMs(q.months[1] + '-15'), rate: q.rate, lo: q.lo, hi: q.hi, lowSample: q.lowSample, k: q.k, recent: q.recent,
        }));
        const pooled = pool(inPeriod);
        const excluded = scenario.riderOnly && isRiderOnlyProgram(prog) && counts != null && pooled
          ? sumExcluded(excludedByMonth(data.crashes, prog, region), inPeriod.filter((p) => p.exposure != null).flatMap((p) => p.months))
          : null;
        return { region, label: CITY_REGION_BY_KEY[region]?.label ?? region, pooled, monthly: inPeriod, quarters, unmapped: regionRateBlock(region) === 'unmapped', excluded };
      }),
    [regions, rates, data.crashes, prog, scenario, period],
  );

  const items: BarItem[] = rows.map((r) => ({
    key: r.region,
    label: r.label,
    sub: r.pooled ? `${r.pooled.months} mo` : undefined,
    rate: r.pooled?.rate ?? null,
    lo: r.pooled?.lo ?? null,
    hi: r.pooled?.hi ?? null,
    lowSample: r.pooled?.lowSample ?? true,
    color,
    reason: r.unmapped ? 'No rate: region not mapped (no crash scope is defined for this area).' : `No ${info.short} miles disclosed for ${r.label} in ${period === 'all' ? 'any month' : period}.`,
  }));
  const shown = rows.filter((r) => r.pooled);
  const anyScenario = rows.some((r) => r.pooled?.scenario);

  // small multiples share their axes
  const allQ = rows.flatMap((r) => r.quarters);
  const sparkT0 = allQ.length ? Math.min(...allQ.map((q) => q.t)) - 30 * 86_400_000 : 0;
  const sparkT1 = allQ.length ? Math.max(...allQ.map((q) => q.t)) + 30 * 86_400_000 : 1;
  const yMax = (allQ.length ? Math.max(...allQ.map((q) => q.rate)) : 1) * 1.12 || 1;

  // counts-only ranking
  // The ranking is per program or per kind group, never across Level 2 and ADS.
  const rankProg = params.get('crk') ?? prog;
  const rankKind = KIND_GROUPS.find((g) => 'kind:' + g.id === rankProg);
  const ranking = useMemo(
    () => rankCities(data.crashes, rankKind ? rankKind.programs : rankProg),
    [data.crashes, rankProg], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const unmatched = useMemo(() => unmatchedCities(ranking), [ranking]);
  const top = ranking.slice(0, 20);
  const maxN = top[0]?.n ?? 1;
  const regionsWithMiles = new Set(regions);
  const totalRanked = ranking.reduce((a, r) => a + r.n, 0);
  const haveMiles = (r: { regions: string[] }) => rankProg === prog && r.regions.some((x) => regionsWithMiles.has(x));
  const unmappedRows = rows.filter((r) => r.unmapped);
  const excludedTotal = rows.reduce((a, r) => a + (r.excluded ? r.excluded.in_vehicle + r.excluded.other : 0), 0);

  const sourceIds = [...new Set(rows.flatMap((r) => r.pooled?.sourceIds ?? []))];

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="cities">
        <h2>Cities: crashes per million miles</h2>
        <p className="prose">
          Only Waymo discloses miles by city, so only Waymo gets city rates. A city's crashes are NHTSA reports whose city field is on the explicit list for that
          service area (below), over the same months as the miles. Waymo's monthly city miles are mostly <b>interpolated estimates</b> between its quarterly or
          annual disclosures, so every bar here is hatched as an estimate. Rates carry an exact Poisson 95% interval.
          Waymo's miles are rider-only, so a city's crash count leaves out crashes that had an in-vehicle operator
          {excludedTotal > 0 ? ` (${fmt(excludedTotal)} excluded over the months shown)` : ''}.
        </p>
        <KindCaveat extra="Only driverless (ADS) programs disclose city miles, so the rates here are all ADS." />
        {unmappedRows.map((r) => (
          <p key={r.region} className="callout health-warn small" role="alert">
            <b>Data health warning:</b> the exposure region <span className="mono">{r.region}</span> has no crash scope in the city map, so it shows no rate (never 0). Add its cities to the map before publishing a rate.
          </p>
        ))}

        <p className="callout small" role="note" style={{ marginTop: 0 }}>
          <b>All city rates rest on interpolated miles (hatched bars).</b> Waymo discloses city miles in quarterly or annual steps, and the monthly split inside each step is an interpolation, so
          month-to-month differences within a city are not measured and a rate for a single month can mislead.
        </p>

        <div className="controls">
          {cityPrograms.length > 1 && (
            <label className="field">
              Program
              <select value={prog} onChange={(e) => setQuery({ cpg: e.target.value === cityPrograms[0] ? null : e.target.value })}>
                {cityPrograms.map((p) => <option key={p} value={p}>{PROGRAM_BY_KEY[p]?.short ?? p}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            Period
            <select value={period} onChange={(e) => setQuery({ cpd: e.target.value === 'all' ? null : e.target.value })}>
              <option value="all">Every month with miles (differs by city)</option>
              {years.map((y) => <option key={y} value={y}>{y}{y === rates.lastMonth.slice(0, 4) ? ' (to ' + rates.lastMonth + ')' : ''}</option>)}
            </select>
          </label>
        </div>

        <figure className="panel rates-chart">
          <figcaption>
            <span className="panel-title">
              {info.short} crashes per million miles by service area, {period === 'all' ? 'all months with miles' : period}
              {anyScenario && <> <ScenarioBadge /></>}
            </span>
            <span className="panel-total">
              Bar: rate · whisker: exact Poisson 95% interval · hatched: estimated miles or fewer than 10 crashes
              <SourceBadge sourceIds={sourceIds} label="City exposure sources" />
            </span>
          </figcaption>
          <RateBars items={items} unit="crashes per million miles" ariaLabel={`${info.short} crashes per million miles by city`} />
          {period === 'all' && (
            <p className="small">
              Cities cover different spans (the number of months with miles follows each name), so with "every month" the bars are not like for like; pick a single year to compare cities over the same months.
            </p>
          )}
          <p className="small">
            San Francisco (city) and the San Francisco Bay Area are overlapping geographies Waymo reported in different periods; they are never added together.
            Hover a bar for its interval. <LowSampleMark /> marks estimated miles or a low count.
          </p>
        </figure>

        <h3>Each service area over time (quarterly)</h3>
        <p className="small">Same axes in every panel. Hollow markers: estimated miles or fewer than 10 crashes. Dashed line: the 2025-06-16 NHTSA rule change. Bands above the axis are clipped.</p>
        <div className="spark-grid">
          {rows.map((r) => (
            <Spark
              key={r.region} title={r.label} sub={r.quarters.length ? '' : '(no full quarter with miles)'} points={r.quarters}
              t0={sparkT0} t1={sparkT1} yMax={yMax} color={color} mode={mode} unit="crashes per million miles"
            />
          ))}
        </div>

        <h3>The numbers</h3>
        <div className="table-wrap">
          <table className="rates-table">
            <caption className="sr-only">Crashes per million miles by service area</caption>
            <thead>
              <tr>
                <th scope="col">Service area</th>
                <th scope="col">NHTSA city names counted</th>
                <th scope="col" className="num">Months</th>
                <th scope="col" className="num">Crashes</th>
                <th scope="col" className="num">Miles</th>
                <th scope="col">Miles kind</th>
                <th scope="col" className="num">Per million miles</th>
                <th scope="col">95% interval</th>
                <th scope="col">Flags</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => (b.pooled?.rate ?? -1) - (a.pooled?.rate ?? -1)).map((r) => (
                <tr key={r.region} className={r.pooled ? '' : 'nodata'}>
                  <th scope="row">{r.label}</th>
                  <td className="small">{CITY_REGION_BY_KEY[r.region]?.state}: {CITY_REGION_BY_KEY[r.region]?.cities.join(', ')}</td>
                  {r.pooled ? (
                    <>
                      <td className="num">{r.pooled.months}</td>
                      <td className="num">{fmt(r.pooled.k)}</td>
                      <td className="num">{fmtNum(r.pooled.exposure)}</td>
                      <td>{r.pooled.kind}</td>
                      <td className="num"><b>{fmtNum(r.pooled.rate)}</b></td>
                      <td>{fmtNum(r.pooled.lo)} to {fmtNum(r.pooled.hi)}</td>
                      <td>{r.pooled.lowSample && <LowSampleMark />}{r.pooled.scenario && <ScenarioBadge />}{r.pooled.incomplete.length > 0 && <IncompleteMark months={r.pooled.incomplete} />}</td>
                      <td><SourceBadge sourceIds={r.pooled.sourceIds} kind={r.pooled.kind} /></td>
                    </>
                  ) : (
                    <td colSpan={8} className="small">{r.unmapped ? 'No rate: region not mapped.' : 'No miles disclosed for this period: no rate.'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="callout small">No service area has miles in this period.</p>}

        <h3>Where the crashes are (counts only)</h3>
        <p className="prose small">
          A city with many crashes is usually a city with many miles; <b>counts are not rates</b>. This ranking exists for programs and cities with no city miles at
          all, where a rate cannot be computed. Bars marked "rate above" have a disclosed-miles service area for {info.short}.
        </p>
        <div className="controls">
          <label className="field">
            Program
            <select value={rankProg} onChange={(e) => setQuery({ crk: e.target.value === prog ? null : e.target.value })}>
              {KIND_GROUPS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  <option value={'kind:' + g.id}>All {g.short === 'ADS' ? 'driverless (ADS)' : 'Level 2'} programs</option>
                  {PROGRAMS.filter((p) => kindOf(p.key) === g.id).map((p) => <option key={p.key} value={p.key}>{p.short}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <span className="small">{fmt(totalRanked)} crashes in {fmt(ranking.length)} cities. Ranked within one program or one kind group, never Level 2 with ADS.</span>
        </div>
        <ul className="bars" aria-label="Crashes by city, counts only">
          {top.map((r) => (
            <li key={r.key}>
              <span className="bar-label">{r.city}, {r.state}</span>
              <span className="bar-track"><i style={{ width: `${(r.n / maxN) * 100}%`, background: haveMiles(r) ? color : t.faint }} /></span>
              <span className="num">{fmt(r.n)} <span className="small">{haveMiles(r) ? 'rate above' : 'counts only'}</span></span>
            </li>
          ))}
        </ul>
        <details className="table-view">
          <summary>
            {unmatched.length} cities in this ranking are not matched to any disclosed-miles service area ({fmt(unmatched.reduce((a, r) => a + r.n, 0))} crashes)
          </summary>
          <p className="small">
            The mapping is explicit: a city counts toward a service area only if its state and name are listed in the table above. Different spellings that are
            plainly the same place are merged; a wrong state (for example "Phoenix, CA") is not guessed at and stays unmatched.
          </p>
          <p className="small">{unmatched.map((r) => `${r.city}, ${r.state} (${r.n})`).join('; ')}</p>
        </details>
        <SourceNote date={data.meta.fetched_date} extra="Crashes: NHTSA SGO crashes per program (one record per program and incident) by the city field. Miles: Waymo Safety Impact hub (see source badges); monthly values are interpolated estimates." />
      </section>
    </SourcesCtx.Provider>
  );
}
