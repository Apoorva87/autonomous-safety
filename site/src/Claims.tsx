import { useMemo } from 'react';
import type { Data } from './data';
import { PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { scopedCounts, regionLabel, useRatesData, type RatesData, type SourceRow } from './data/rates';
import { defaultRegion } from './Rates';
import { waymoBenchmark, type Forest } from './lib/claims';
import { series, type Point } from './lib/metrics';
import { fmtCI, fmtInt, fmtNum, fmtRateText } from './lib/format';
import { KIND_GROUPS, kindLabel, kindOf, type KindId } from './lib/kinds';
import { KindCaveat } from './components/KindCaveat';
import { IncompleteMark } from './components/FlagNote';
import { useScenario } from './state/scenario';
import { TeslaVsrPanel } from './components/TeslaVsrPanel';
import type { BarItem } from './components/RateBars';
import { LowSampleMark, ScenarioBadge, SourceBadge, SourcesCtx } from './components/SourceBadge';
import { SourceNote } from './EChart';

export function Claims({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the data files ({error}).</p>;
  if (!rates) return <p className="loading">Loading company-reported and exposure data…</p>;
  return <ClaimsLoaded data={data} rates={rates} mode={mode} />;
}

const PROGRAMS_WITH_DENOM = ['waymo_ads', 'gm_cruise_ads', 'gm_supercruise'];
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

/** What a company-reported or NHTSA-derived number counts. Window and scope come from the data rows or the order itself; methodology text is sources.json verbatim. */
type Counts = { id: string; label: string; window: string; crash: string; scope: string; sourceIds: string[] };

function ClaimsLoaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const [scenario] = useScenario();
  const t = ui(mode);
  const src = rates.sources;

  const derived = useMemo(
    () =>
      PROGRAMS_WITH_DENOM.map((prog) => {
        const region = defaultRegion(rates, prog, 'milesPerCrash');
        const counts = scopedCounts(rates.countRows, data.crashes, prog, region === 'global' ? 'us' : region, { riderOnly: scenario.riderOnly });
        const pts = series(counts, rates.exposure, scenario, {
          program: prog, region, metric: 'milesPerCrash', grain: 'year', firstYear: 2021, lastMonth: rates.lastMonth, lag: rates.lag[prog],
        }).filter((p) => (p.rate != null || p.lowerBound) && !p.notes.some((n) => /assumed miles per vehicle/.test(n)));
        return { prog, region, info: PROGRAM_BY_KEY[prog], pts };
      }).filter((d) => d.pts.length > 0),
    [rates, data.crashes, scenario],
  );
  // The latest COMPLETE year with a rate, per program, for the dot summary. One summary per kind group: ADS and Level 2 never share an axis.
  const latest = derived.map((d) => ({ d, p: [...d.pts].reverse().find((p) => !p.partial && p.rate != null) ?? [...d.pts].reverse().find((p) => p.rate != null)! }));
  const barsByKind: Record<KindId, BarItem[]> = { ads: [], l2: [] };
  for (const { d, p } of latest) {
    const k = kindOf(d.prog);
    if (!k || !p) continue;
    barsByKind[k].push({
      key: d.prog, label: d.info.short, sub: p.period + (p.partial ? ' (partial)' : ''), rate: p.rate, lo: p.lo, hi: p.hi, lowSample: p.lowSample,
      color: colorOf(d.info.color, mode),
    });
  }

  const bench = useMemo(() => waymoBenchmark(rates.company), [rates.company]);
  const benchSources = [...new Set(rates.company.filter((r) => r.program === 'waymo_ads').flatMap((r) => r.source_ids))];
  const teslaRow = rates.company.find((r) => r.metric === 'vsr_miles_per_crash_autopilot');
  const gmRow = rates.company.find((r) => r.metric === 'crashes_attributed_to_system');
  const waymoRow = rates.company.find((r) => r.program === 'waymo_ads' && r.metric === 'police_reported_crashes');

  const counts: Counts[] = [
    {
      id: 'tesla', label: 'Tesla Vehicle Safety Report, "miles per crash"',
      window: `${teslaRow?.window ?? '5s'}: Autopilot or FSD counted if it was active, or deactivated, within 5 seconds before impact (the report's wording: deactivated within 5 seconds before impact)`,
      crash: teslaRow?.method_note ?? 'Airbag or active-restraint deployment.',
      scope: 'Worldwide fleet telemetry (geography not stated); includes crashes that are not reportable to NHTSA',
      sourceIds: ['tesla_vsr_wb_20251030'],
    },
    {
      id: 'sgo-l2', label: 'NHTSA SGO, driver-assist (Level 2): Tesla, GM Super Cruise and others',
      window: '30 seconds: the Level 2 system must have been engaged at any time within 30 seconds before the crash, through its conclusion',
      crash: 'Only a crash meeting the order\'s Level 2 thresholds is reportable (for example a fatality, hospital-treated injury, vulnerable road user, airbag deployment or tow-away; the thresholds changed on 2025-06-16, see the order). This is much narrower than the ADS threshold, so L2 and ADS counts are not comparable',
      scope: 'United States; every reporter subject to the order',
      sourceIds: ['nhtsa_sgo_page', 'nhtsa_sgo_third_amended', 'nhtsa_sgo_ded_archive'],
    },
    {
      id: 'sgo-ads', label: 'NHTSA SGO, driverless (ADS): Waymo, Zoox, Cruise and others',
      window: '30 seconds: the ADS must have been engaged at any time within 30 seconds before the crash, through its conclusion (the same window as Level 2)',
      crash: 'Essentially any crash involving the ADS vehicle that meets the order\'s ADS thresholds (for example any injury or any property damage; changed 2025-06-16). Much broader than the Level 2 threshold, so ADS and L2 counts are not comparable',
      scope: 'United States',
      sourceIds: ['nhtsa_sgo_page', 'nhtsa_sgo_third_amended', 'nhtsa_sgo_ded_archive'],
    },
    {
      id: 'waymo', label: 'Waymo Safety Impact hub, benchmark comparison',
      window: waymoRow?.window ?? 'SGO-reported RO crashes',
      crash: 'SGO reports that Waymo classifies by outcome (police-reported, any injury, airbag, serious injury or worse, fatal), counted regardless of fault',
      scope: 'United States, rider-only (no human driver) miles only; compared with a Waymo-built human benchmark',
      sourceIds: ['waymo_hub_20261002', 'waymo_hub_csv3_202606'],
    },
    {
      id: 'gm', label: 'GM, "accident-free" Super Cruise miles',
      window: 'Not stated',
      crash: gmRow ? 'GM attributes 0 crashes to the system but does not define "accident-free"' : 'Not defined',
      scope: 'North America hands-free miles',
      sourceIds: ['gm_news_20240215'],
    },
    {
      id: 'this', label: 'This site\'s derived rates (Rates, Cities and Learning tabs)',
      window: 'As filed with NHTSA: a 30-second engagement window for both ADS and Level 2',
      crash: 'Crashes per program (one record per program and incident) matched by region and month to the miles; for rider-only programs only crashes with no in-vehicle operator',
      scope: 'Only where a sourced denominator exists for the same region; many miles are estimates',
      sourceIds: ['nhtsa_sgo_page'],
    },
  ];

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="claims">
        <h2>Claims vs filings</h2>
        <p className="prose">
          Companies publish safety numbers, and NHTSA publishes the crash reports. They count different things (different windows, different definitions of a
          crash, different places), so <b>the two are shown in separate panels on separate axes and are never merged into one series</b>. Read the "what each number
          counts" table before comparing anything by eye.
        </p>
        <KindCaveat extra="Level 2 and ADS results below are therefore in separate panels, each on its own axis." />

        <div className="claims-grid">
          <div className="claims-col">
            <h3>What the company says</h3>
            <TeslaVsrPanel rows={rates.company} mode={mode} />
            <MethodBox ids={['tesla_vsr_wb_20251030']} src={src} />
          </div>

          <div className="claims-col">
            <h3>What the NHTSA filings give</h3>
            <section className="vsr-panel">
              <h3>NHTSA-derived miles per crash, where a fair denominator exists</h3>
              <p className="prose small">
                SGO crashes divided into miles for the <em>same</em> region and months, with an exact Poisson 95% interval. These cover the programs with
                disclosed miles; <b>Tesla Autopilot/FSD is absent on purpose</b>: Tesla discloses worldwide miles only, and NHTSA's counts cannot be split between
                Autopilot and FSD, so no US denominator exists. These are NHTSA counts with a 30-second engagement window, not Tesla's 5-second airbag counts.
                For GM Cruise only crashes with no in-vehicle operator are counted, to match its driverless miles.
              </p>
              {KIND_GROUPS.map((g) => {
                const rows = derived.filter((d) => kindOf(d.prog) === g.id);
                if (rows.length === 0) return null;
                return (
                  <div key={g.id} className={`kind-panel kind-${g.id}`}>
                    <h4 className="small-h">{kindLabel(g.id)}</h4>
                    {barsByKind[g.id].length > 0 ? (
                      <MpcDots items={barsByKind[g.id]} t={t} kind={g.id} />
                    ) : (
                      <p className="small">No program of this kind has a usable denominator right now.</p>
                    )}
                    <div className="table-wrap">
                      <table className="rates-table">
                        <caption className="sr-only">{kindLabel(g.id)}: NHTSA-derived miles per crash by program and year</caption>
                        <thead>
                          <tr>
                            <th scope="col">Program</th>
                            <th scope="col">Year</th>
                            <th scope="col" className="num">Crashes</th>
                            <th scope="col" className="num">Miles</th>
                            <th scope="col" className="num">Miles per crash</th>
                            <th scope="col">95% interval</th>
                            <th scope="col">Flags</th>
                            <th scope="col">Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.flatMap((d) =>
                            d.pts.map((p: Point) => (
                              <tr key={d.prog + p.period}>
                                <td>{d.info.short}<span className="small"> {regionLabel(d.region)}</span></td>
                                <td>{p.period}</td>
                                <td className="num">{fmtInt(p.k)}</td>
                                <td className="num">{fmtNum(p.exposure)}</td>
                                <td className="num"><b>{fmtRateText(p)}</b></td>
                                <td>{fmtCI(p)}</td>
                                <td>
                                  {p.lowSample && p.rate != null && <LowSampleMark />}{p.scenario && <ScenarioBadge />}
                                  {p.incomplete.length > 0 && <IncompleteMark months={p.incomplete} />}
                                  {p.partial && <span className="small"> {p.months.length} mo</span>}
                                  {p.period === '2025' && <span className="small"> spans the 2025-06-16 rule change</span>}
                                </td>
                                <td><SourceBadge sourceIds={p.sourceIds} kind={p.exposureKind} method={p.method} /></td>
                              </tr>
                            )),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              <p className="small">Hollow markers: estimated miles or fewer than 10 crashes. Years that include late months (recent months are incomplete: late reports expected) and 2025, which straddles the 2025-06-16 rule change, are flagged. For other programs and months, use the Rates tab.</p>
            </section>
          </div>
        </div>

        <h3>What each number counts</h3>
        <p className="small">
          Window, crash definition and scope for each source. Window and definition for company figures come from the data rows; the SGO rows summarise the
          order (follow the links for its exact text). The last column is the methodology and caveat text from <span className="mono">sources.json</span>, unedited.
        </p>
        <div className="table-wrap">
          <table className="counts-table">
            <caption className="sr-only">What each safety number counts</caption>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Window</th>
                <th scope="col">What counts as a crash</th>
                <th scope="col">Scope</th>
                <th scope="col">Source methodology and caveats</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.label}</th>
                  <td>{c.window}</td>
                  <td>{c.crash}</td>
                  <td>{c.scope}</td>
                  <td className="small"><MethodText ids={c.sourceIds} src={src} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Waymo's benchmark comparison (company-reported)</h3>
        <section className="vsr-panel">
          <p className="prose small">
            Waymo compares its rider-only miles with a human benchmark it builds from police-reported and state data, adjusted for where and when Waymo drives.
            The percentages are <b>Waymo's own analysis</b> of SGO reports that it classifies by outcome. They are not computed here and are not the NHTSA-derived
            rates above. Negative means fewer crashed vehicles per mile than the benchmark.
            <SourceBadge sourceIds={benchSources} label="Waymo hub sources" />
          </p>
          {bench.length > 0 ? (
            <>
              <ForestPlot rows={bench} t={t} color={colorOf(PROGRAM_BY_KEY.waymo_ads.color, mode)} />
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Waymo hub comparison to the human benchmark</caption>
                  <thead>
                    <tr>
                      <th scope="col">Outcome</th>
                      <th scope="col">Through</th>
                      <th scope="col" className="num">Waymo crashes</th>
                      <th scope="col" className="num">Benchmark predicts</th>
                      <th scope="col" className="num">Difference</th>
                      <th scope="col">95% interval (Waymo's)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bench.map((r) => (
                      <tr key={r.metric}>
                        <th scope="row">{r.outcome}</th>
                        <td>{r.period}</td>
                        <td className="num">{r.crashes == null ? 'n/a' : fmtInt(r.crashes)}</td>
                        <td className="num">{r.predicted == null ? 'n/a' : r.predicted.toFixed(1)}</td>
                        <td className="num"><b>{r.pct.toFixed(1)}%</b></td>
                        <td>{r.lo == null ? 'see note' : `${r.lo.toFixed(1)}% to ${r.hi!.toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="small">No Waymo comparison rows in the data.</p>
          )}
          <h4 className="small-h">Caveats</h4>
          <MethodBox ids={['waymo_hub_20261002', 'waymo_hub_csv3_202606']} src={src} />
          <p className="small">
            Things to keep in mind: the benchmark is a model, not a measured group of human drivers on the same roads; only miles with no human behind the wheel count; a "crash" here is
            whatever Waymo classifies from SGO reports (counted regardless of fault); and the comparison inherits every reporting-threshold change in the SGO. The 95% intervals shown
            are Waymo's, taken from its published notes.
          </p>
        </section>
        <SourceNote date={data.meta.fetched_date} extra="Company-reported figures come from company_reported.json (Tesla Vehicle Safety Report archive, Waymo Safety Impact hub, GM statements); NHTSA-derived figures from SGO crashes and the exposure data." />
      </section>
    </SourcesCtx.Provider>
  );
}

function MethodText({ ids, src }: { ids: string[]; src: Record<string, SourceRow> }) {
  return (
    <>
      {ids.map((id) => {
        const s = src[id];
        if (!s) return <p key={id} className="small mono">{id}: not in sources.json</p>;
        const url = safeUrl(s.url);
        return (
          <p key={id} className="small" style={{ margin: '0 0 6px' }}>
            <b>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{s.publisher}</a> : s.publisher}</b>: {s.methodology}
            {s.caveats ? ` Caveats: ${s.caveats}` : ''}
          </p>
        );
      })}
    </>
  );
}

function MethodBox({ ids, src }: { ids: string[]; src: Record<string, SourceRow> }) {
  return (
    <div className="callout" style={{ marginTop: 10, maxWidth: 'none' }}>
      <MethodText ids={ids} src={src} />
    </div>
  );
}

/** Latest-year miles per crash per program on a log axis (driver-assist and driverless programs differ by an order of magnitude). Hollow = low sample or estimated miles. */
function MpcDots({ items, t, kind }: { items: BarItem[]; t: ReturnType<typeof ui>; kind: KindId }) {
  const ok = items.filter((i) => i.rate != null && i.lo != null);
  if (ok.length === 0) return null;
  const lo10 = Math.floor(Math.log10(Math.min(...ok.map((i) => i.lo as number))));
  const hi10 = Math.ceil(Math.log10(Math.max(...ok.map((i) => i.hi ?? (i.rate as number)))));
  const W = 480;
  const L = 178;
  const R = 26;
  const rowH = 30;
  const H = ok.length * rowH + 52;
  const x = (v: number) => L + ((Math.log10(Math.max(v, 10 ** lo10)) - lo10) / (hi10 - lo10 || 1)) * (W - L - R);
  const decades = Array.from({ length: hi10 - lo10 + 1 }, (_, i) => 10 ** (lo10 + i));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="forest" role="img" aria-label={`NHTSA-derived miles per crash, ${kindLabel(kind)} programs, latest year, with 95% intervals, on a logarithmic axis`}>
      {decades.map((d) => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={4} y2={H - 26} stroke={t.grid} />
          <text x={x(d)} y={H - 18} textAnchor="middle" fontSize="11" fill={t.muted}>{fmtNum(d)}</text>
        </g>
      ))}
      <text x={(L + W - R) / 2} y={H - 2} textAnchor="middle" fontSize="11" fill={t.muted}>miles per crash (log scale)</text>
      {ok.map((i, n) => {
        const y = 16 + n * rowH;
        return (
          <g key={i.key}>
            <text x={L - 8} y={y + 4} textAnchor="end" fontSize="12" fill={t.ink}>{i.label} {i.sub}</text>
            <line x1={x(i.lo as number)} x2={x(i.hi ?? (i.rate as number))} y1={y} y2={y} stroke={i.color} strokeWidth={2.5} />
            <circle cx={x(i.rate as number)} cy={y} r={6} fill={i.lowSample ? t.surface : i.color} stroke={i.color} strokeWidth={2.5} />
          </g>
        );
      })}
    </svg>
  );
}

/** Percent difference vs benchmark with its interval; 0 = equal to the benchmark. */
function ForestPlot({ rows, t, color }: { rows: Forest[]; t: ReturnType<typeof ui>; color: string }) {
  const W = 640;
  const rowH = 30;
  const L = 190;
  const R = 70;
  const H = rows.length * rowH + 34;
  const x = (v: number) => L + ((v + 100) / 100) * (W - L - R);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Waymo percent difference in crashed-vehicle rate versus a human benchmark, by outcome, with 95% intervals" className="forest">
      {[-100, -75, -50, -25, 0].map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={6} y2={H - 24} stroke={v === 0 ? t.ink : t.grid} strokeWidth={v === 0 ? 1.5 : 1} />
          <text x={x(v)} y={H - 8} textAnchor="middle" fontSize="11" fill={t.muted}>{v}%</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = 12 + i * rowH + rowH / 2 - 6;
        return (
          <g key={r.metric}>
            <text x={L - 8} y={y + 4} textAnchor="end" fontSize="11.5" fill={t.ink}>{r.outcome.length > 26 ? r.outcome.slice(0, 25) + '…' : r.outcome}</text>
            {r.lo != null && r.hi != null && <line x1={x(r.lo)} x2={x(r.hi)} y1={y} y2={y} stroke={color} strokeWidth={2.5} />}
            <circle cx={x(r.pct)} cy={y} r={5.5} fill={color} stroke={t.surface} strokeWidth={2} />
            <text x={W - R + 6} y={y + 4} fontSize="11.5" fill={t.muted}>{r.pct.toFixed(0)}%</text>
          </g>
        );
      })}
      <text x={x(0) - 4} y={9} textAnchor="end" fontSize="10" fill={t.muted}>fewer crashes than benchmark</text>
    </svg>
  );
}
