import type { Data } from './data';
import { fmt } from './data';
import { SourceNote } from './EChart';

const CAVEATS: [string, string][] = [
  ['Different crash windows', 'NHTSA counts crashes within 30 seconds of automation being engaged. Tesla\'s own safety report uses 5 seconds. The two are never put in one series.'],
  ['Rules changed 2025-06-16', 'NHTSA\'s amended Standing General Order changed which crashes must be reported and how. A drop across that date is a reporting change, not a safety improvement.'],
  ['Month-level dates only', 'Incident dates are published as month and year. Exact location is redacted; the city is the finest place available.'],
  ['Redactions', 'Tesla redacts almost every narrative and its software version as confidential business information, so Autopilot and FSD cannot be told apart in this data, and narrative-based tags are unavailable for Tesla.'],
  ['Severity is not deaths', 'NHTSA records the highest injury level per report. It does not count deaths, so "fatal" means at least one reported fatality, not how many.'],
  ['Counts, not rates', 'Programs differ greatly in miles driven and vehicles on the road. This preview shows counts and structure only; rates need sourced mileage and fleet data, which is still being researched.'],
  ['Unique crashes', 'Several reports can describe one crash (different companies, or follow-up versions). Charts count distinct incident IDs and use the highest injury level among them.'],
];

export function Sources({ data }: { data: Data }) {
  const { meta } = data;
  return (
    <section>
      <h2>Data and sources</h2>
      <p className="prose">
        All figures come from NHTSA's Standing General Order 2021-01 crash reports (automated driving systems and
        Level 2 driver assistance). Files were downloaded on {meta.fetched_date}; the newest NHTSA file was modified on{' '}
        {meta.nhtsa_last_modified}. Dashboard data was built on {meta.run_date}.
      </p>
      <dl className="facts">
        <div>
          <dt>Reports (latest version of each)</dt>
          <dd>{fmt(meta.total_reports)}</dd>
        </div>
        <div>
          <dt>Unique crashes</dt>
          <dd>{fmt(meta.total_incidents)}</dd>
        </div>
        <div>
          <dt>"No new reports" filings skipped</dt>
          <dd>{fmt(meta.placeholder_rows_skipped)}</dd>
        </div>
      </dl>

      <h3>NHTSA files</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>NHTSA last modified</th>
              <th className="num">Rows</th>
              <th>SHA-256</th>
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

      <h3>Caveats to read before drawing conclusions</h3>
      <ul className="caveats">
        {CAVEATS.map(([h, b]) => (
          <li key={h}>
            <b>{h}.</b> {b}
          </li>
        ))}
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
