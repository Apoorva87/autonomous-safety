import { useEffect, useMemo, useState } from 'react';
import type { Data } from './data';
import { fmt } from './data';
import { SourceNote } from './EChart';
import { KIND_CAVEAT } from './lib/kinds';
import { csvCell } from './lib/format';
import type { SourceRow } from './data/rates';

const base = import.meta.env.BASE_URL;
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

type Registry = SourceRow & { source_type?: string; accessed?: string };
type Changelog = { entries: { run_id: string; run_at: string; new_reports: number; revised_reports: number; removed_reports: number }[] };

async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${base}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const CAVEATS: [string, string][] = [
  ['Level 2 and ADS are not comparable', KIND_CAVEAT + ' Under the order, a Level 2 crash is reportable only when it meets severity, vulnerable-road-user, airbag or tow-away criteria, while an ADS crash is reportable at almost any contact. Most of the gap between the two kinds of programs is this definition, not safety. The site never puts the two on one axis, funnel, ranking or overlaid line.'],
  ['Crash windows', 'NHTSA SGO reports use a 30-second engagement window for both ADS and Level 2: the system must have been engaged within 30 seconds before the crash, through its conclusion. Tesla\'s Vehicle Safety Report counts crashes with Autopilot active, or deactivated, within 5 seconds before impact (airbag or active-restraint deployments). The two are never put in one series.'],
  ['Rules changed 2025-06-16', 'NHTSA\'s Third Amended Standing General Order changed which crashes must be reported and the data schema. Minor crashes without injury, air bag or tow-away largely stopped being reported, so a count of all reported crashes drops at that date whatever happened on the road. Time charts therefore count threshold-robust crashes by default (definition below), never join a line across the date, and carry a badge; the all-crash count stays available as a labelled option. Cities are ranked within one regime only.'],
  ['Tesla incident times are UTC', 'Tesla files incident times in UTC; every other reporter files local time. Hours and light conditions convert Tesla times to the local time of the report\'s state (details below). Without the conversion Tesla\'s crashes look like night-time crashes.'],
  ['Fields that exist in one era only', 'Lighting, road surface and speed limit are collected only through 2025-06-15; hospitalization is spelled out only from 2025-06-16 (so it is never true before). Any chart that uses them shows a false onset or end at the change; the light condition derived from time is the comparable alternative.'],
  ['Rider-only miles', 'Waymo, Cruise, Zoox and Tesla Robotaxi miles are rider-only (no human driver on board). By default their rates count only crashes whose operator type is none or remote; crashes with an in-vehicle operator are left out and the number excluded is shown. The scenario panel can turn this off.'],
  ['California DMV miles are not a denominator', 'California DMV autonomous-testing miles cover Dec-Nov reporting years and include testing with safety drivers, so they cannot be matched to SGO crashes (calendar months, all operations). They appear as an informational series labelled "CA DMV testing miles, Dec–Nov, not comparable with SGO crashes", never as a rate.'],
  ['Estimates are labelled', 'Every exposure figure is tagged reported, derived or estimate. Where no mileage is disclosed (Zoox, other reporters, Tesla before 2024-10), no per-mile rate is drawn; a miles-per-vehicle assumption you set yourself is badged as your assumption. Tesla\'s per-mile rates use FSD (Supervised) miles only, while its NHTSA counts include Autopilot. Per-vehicle rates are per vehicle-year, with partial years flagged.'],
  ['Recent months are incomplete', 'Reports arrive weeks after a crash. Months whose reports are usually less than 90% filed are drawn dotted or hatched and marked "late reports"; a dip there is not an improvement. The late-report adjustment in the scenario panel is optional and off by default.'],
  ['Month-level dates only', 'Incident dates are published as month and year. Exact location is redacted; the city is the finest place available.'],
  ['Redactions', 'Tesla redacts almost every narrative and its software version as confidential business information, so Autopilot and FSD cannot be told apart in this data, and narrative-based tags are unavailable for Tesla.'],
  ['Severity is not deaths', 'NHTSA records the highest injury level per report. It does not count deaths, so "fatal" means at least one reported fatality, not how many.'],
  ['Crashes per program', 'Several reports can describe one crash (different companies, or follow-up versions). A crash filed by two programs counts once under each (one record per program and incident, each from that program\'s own report), so per-program counts overlap and are never summed; the number of unique incidents is shown separately.'],
];

export function Sources({ data }: { data: Data }) {
  const { meta } = data;
  const [registry, setRegistry] = useState<Registry[] | null>(null);
  const [changelog, setChangelog] = useState<Changelog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    getJson<{ rows: Registry[] }>('sources.json').then((r) => setRegistry(r.rows), (e) => setErr(String(e)));
    getJson<Changelog>('changelog.json').then(setChangelog, (e) => setErr(String(e)));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!registry) return [];
    if (!needle) return registry;
    return registry.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }, [registry, q]);

  const downloadRecordsCsv = () => {
    const fields = Object.keys(data.crashes[0] ?? {}) as (keyof (typeof data.crashes)[number])[];
    const lines = [fields.join(',')];
    for (const c of data.crashes) lines.push(fields.map((f) => csvCell(Array.isArray(c[f]) ? (c[f] as unknown[]).join(';') : c[f])).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autonomous-safety-records-program-level.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const stale = meta.disclosures.filter((d) => d.stale);

  return (
    <section>
      <h2>Data and sources</h2>
      <p className="prose">
        Crash counts come from NHTSA's Standing General Order 2021-01 crash reports (automated driving systems and
        Level 2 driver assistance). Exposure (miles, vehicles) comes from company disclosures listed in the source registry below.
        Files were downloaded on {meta.fetched_date}; the newest NHTSA file was modified on{' '}
        {meta.nhtsa_last_modified}. Dashboard data was built on {meta.run_date} (run {meta.run_id}, rules {meta.rules_version}).
      </p>
      <dl className="facts">
        <div>
          <dt>Reports (latest version of each)</dt>
          <dd>{fmt(meta.total_reports)}</dd>
        </div>
        <div>
          <dt>Unique incidents</dt>
          <dd>{fmt(meta.counts_total.unique_incidents)}</dd>
        </div>
        <div>
          <dt>Program-level crash records</dt>
          <dd>{fmt(data.crashes.length)}</dd>
        </div>
        <div>
          <dt>"No new reports" filings skipped</dt>
          <dd>{fmt(meta.placeholder_rows_skipped)}</dd>
        </div>
      </dl>

      {meta.offline && (
        <p className="callout health-warn small" role="note">
          <b>Offline build.</b> {meta.offline_note ?? 'The raw NHTSA files were not downloaded in the run that produced this data.'}
        </p>
      )}

      <h3>Validation warnings and stale disclosures</h3>
      {meta.warnings.length === 0 && stale.length === 0 ? (
        <p className="small">The last run produced no warnings.</p>
      ) : (
        <>
          {stale.length > 0 && (
            <p className="small">
              <b>Stale disclosures</b> (a company has not published its next figure on its usual schedule, so the latest exposure is out of date):{' '}
              {stale.map((d) => `${d.program} ${d.metric} last covers ${d.last_date}, ${d.age_days} days ago, expected every ${d.expected_every_days} days`).join('; ')}.
            </p>
          )}
          <ul className="caveats" aria-label="Warnings from the last data run">
            {meta.warnings.map((w) => <li key={w} className="small">{w}</li>)}
          </ul>
        </>
      )}

      <h3>Caveats to read before drawing conclusions</h3>
      <ul className="caveats">
        {CAVEATS.map(([h, b]) => (
          <li key={h}>
            <b>{h}.</b> {b}
          </li>
        ))}
      </ul>

      <DerivedClasses data={data} />

      <h3>NHTSA files and fetch log</h3>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">NHTSA files: last modified, retrieval time, rows and SHA-256</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">NHTSA last modified</th>
              <th scope="col">Retrieved</th>
              <th scope="col" className="num">Rows</th>
              <th scope="col">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {meta.files.map((f) => (
              <tr key={f.key}>
                <td>
                  {f.url.startsWith('https://static.nhtsa.gov/') ? (
                    <a href={f.url} rel="noopener noreferrer">
                      {f.key}
                    </a>
                  ) : (
                    f.key
                  )}
                </td>
                <td>{f.last_modified.replace(' GMT', '')}</td>
                <td>{f.retrieved_at}</td>
                <td className="num">{fmt(f.rows)}</td>
                <td className="mono">{f.sha256}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="prose small">
        Rows include "no new reports" filings and earlier versions of reports; the dashboard keeps the latest version
        of each report. "archive" files cover 2021-07 to 2025-06-15, "current" files cover 2025-06-16 onward.
      </p>

      <h3>Source registry</h3>
      <p className="small">
        Every company figure and investigation on the site cites a source from this registry (also reachable from the (i) buttons next to each number).
        Methodology and caveats are as recorded when the source was read; the locator says where in the document the figure sits.
      </p>
      <div className="controls">
        <label className="field">
          Search the registry
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="publisher, id, title, caveat" aria-label="Search the source registry" />
        </label>
        <span className="small" aria-live="polite">{registry ? `${shown.length} of ${registry.length} sources` : err ? 'Could not load sources.json' : 'Loading…'}</span>
      </div>
      <div className="table-wrap">
        <table className="registry-table">
          <caption className="sr-only">Source registry</caption>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Publisher</th>
              <th scope="col">Title</th>
              <th scope="col">URL</th>
              <th scope="col">Published</th>
              <th scope="col">Date range</th>
              <th scope="col">Type</th>
              <th scope="col">Methodology</th>
              <th scope="col">Caveats</th>
              <th scope="col">Locator</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const url = safeUrl(r.url);
              return (
                <tr key={r.source_id}>
                  <td className="mono">{r.source_id}</td>
                  <td>{r.publisher}</td>
                  <td>{r.title}</td>
                  <td className="small">{url ? <a href={url} target="_blank" rel="noopener noreferrer">link</a> : r.url}</td>
                  <td>{r.published}</td>
                  <td>{r.date_range}</td>
                  <td>{r.source_type ?? ''}</td>
                  <td className="small">{r.methodology}</td>
                  <td className="small">{r.caveats}</td>
                  <td className="small">{r.locator}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Changelog</h3>
      <p className="small">What changed in the NHTSA reports at each data run. Rebuilds of the same data show zeros.</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Data run changelog</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Run time (UTC)</th>
              <th scope="col" className="num">New reports</th>
              <th scope="col" className="num">Revised</th>
              <th scope="col" className="num">Removed</th>
            </tr>
          </thead>
          <tbody>
            {(changelog?.entries ?? []).map((e) => (
              <tr key={e.run_id}>
                <td className="mono">{e.run_id}</td>
                <td>{e.run_at}</td>
                <td className="num">{fmt(e.new_reports)}</td>
                <td className="num">{fmt(e.revised_reports)}</td>
                <td className="num">{fmt(e.removed_reports)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Download the data</h3>
      <ul className="caveats">
        <li><a href={`${base}data/records.json`} download>records.json</a>: one row per program and incident (columnar JSON, no narratives).</li>
        <li><button type="button" className="link" onClick={downloadRecordsCsv}>records as CSV</button> (the same rows, built in your browser).</li>
        <li><a href={`${base}data/responsibility.json`} download>responsibility.json</a>: the inferred responsibility labels, one per report, with rule, confidence and basis (not a finding of fault).</li>
        <li><a href={`${base}data/counts.json`} download>counts.json</a>, <a href={`${base}data/exposure.json`} download>exposure.json</a>, <a href={`${base}data/sources.json`} download>sources.json</a>: the counts, exposure and registry behind the Rates tab.</li>
      </ul>

      <h3>Failure-pattern tag rules</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Tag</th>
              <th>Based on</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {meta.tag_rules.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>{r.t}</td>
                <td>{r.basis === 'field' ? 'Structured field' : 'Narrative keywords'}</td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SourceNote date={meta.fetched_date} />
    </section>
  );
}

const LABEL_SHORT: Record<string, string> = { day: 'Day', twilight: 'Twilight', night: 'Night' };

/** Definitions of the derived classes the pipeline adds, with their uncertainty and the checks behind them. */
function DerivedClasses({ data }: { data: Data }) {
  const { meta } = data;
  const rd = meta.robust_definition;
  const ne = meta.not_engaged;
  const lc = meta.light_check as Record<string, { n: number; day_night_agreement: number | null; opposite: number; recorded_by_derived: Record<string, Record<string, number>> }> | undefined;
  const pctOf = (x: number | null | undefined) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
  return (
    <>
      <h3>Derived classes and corrections</h3>
      {rd && (
        <div className="callout small">
          <b>Threshold-robust crashes ({rd.short}).</b> {rd.why}
          <ul>
            <li><b>Driverless (ADS) programs:</b> {rd.ads}</li>
            <li><b>Level 2 programs:</b> {rd.l2}</li>
          </ul>
          <b>Uncertainty.</b>
          <ul>{rd.uncertainty.map((u) => <li key={u}>{u}</li>)}</ul>
          A crash is robust when any of the program&rsquo;s own reports of it meets a criterion. It is the default numerator on every time chart (Rates, Timeline, Cities, Before / after).
        </div>
      )}
      {ne && (
        <div className="callout small">
          <b>{fmt(ne.total)} reports are not counted as crashes of their program</b> because the filer marked the automation as <em>verified not engaged</em> (Engagement Status, collected from 2025-06-16):{' '}
          {Object.entries(ne.by_program).map(([p, n]) => `${p} ${n}`).join(', ')}. They stay in the golden database and in the revisions statistics.
          {Object.keys(ne.alleged_engaged_by_program).length > 0 && <> Reports marked <em>alleged engaged</em> are counted as filed ({Object.entries(ne.alleged_engaged_by_program).map(([p, n]) => `${p} ${n}`).join(', ')}).</>}
        </div>
      )}
      {meta.time_rule && (
        <div className="callout small">
          <b>Local time.</b> {meta.time_rule}
          {lc?.tesla_as_filed && lc?.tesla_converted_from_utc && (
            <> Check (archive-era Tesla reports with a recorded Lighting value, day vs night): {pctOf(lc.tesla_as_filed.day_night_agreement)} agree as filed, {pctOf(lc.tesla_converted_from_utc.day_night_agreement)} after converting
            ({fmt(lc.tesla_as_filed.n)} reports); every other reporter: {pctOf(lc.other_reporters?.day_night_agreement)} as filed.</>
          )}
        </div>
      )}
      {meta.light_rule && (
        <div className="callout small">
          <b>Light condition (approximate).</b> {meta.light_rule} Before 2025-06-16 the recorded Lighting field is used where it exists (basis &ldquo;recorded&rdquo;); after it, Lighting is no longer collected and the condition is derived
          from time (basis &ldquo;derived from time&rdquo;). The visibility tag in the Patterns tab still uses the recorded field only, so it cannot fire after the change; the EA26002 lens and the time-of-day view use the derived condition.
          {lc?.all_reporters && <> Where both exist, recorded and derived agree on day vs night in {pctOf(lc.all_reporters.day_night_agreement)} of {fmt(lc.all_reporters.n)} reports.</>}
          {meta.sun_table && (
            <details className="table-view">
              <summary>Sunrise and sunset table used (local clock time, mid-month)</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Month</th>{Object.keys(meta.sun_table).map((m) => <th key={m} scope="col" className="num">{m}</th>)}</tr></thead>
                  <tbody>
                    <tr><th scope="row">Sunrise</th>{Object.values(meta.sun_table).map((v, i) => <td key={i} className="num">{v.sunrise}</td>)}</tr>
                    <tr><th scope="row">Sunset</th>{Object.values(meta.sun_table).map((v, i) => <td key={i} className="num">{v.sunset}</td>)}</tr>
                  </tbody>
                </table>
              </div>
              {lc?.all_reporters && (
                <p className="small">Recorded (rows) vs derived (columns): {Object.entries(lc.all_reporters.recorded_by_derived).map(([r, c]) => `${LABEL_SHORT[r] ?? r}: ${Object.entries(c).map(([d, n]) => `${LABEL_SHORT[d] ?? d} ${n}`).join(', ')}`).join('; ')}.</p>
              )}
            </details>
          )}
        </div>
      )}
      {meta.field_notes?.hospitalized && <p className="small-block"><b>Hospitalized:</b> {meta.field_notes.hospitalized}</p>}
    </>
  );
}
