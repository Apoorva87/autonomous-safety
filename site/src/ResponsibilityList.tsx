import { useEffect, useMemo, useRef } from 'react';
import { fmt, humanize } from './data';
import { PROGRAM_BY_KEY, SEVERITY_LABEL, LABEL_COLOR, colorOf, type Mode } from './theme';
import {
  CONFIDENCE_NAME, LABEL_KEY_NAME, applyFilters, evidenceFor, labelName, toCsv,
  type JoinedRow, type RespFilters,
} from './lib/responsibility';
import { ZONE_LABEL, zonesOf } from './lib/impact';
import { setQuery, useQuery } from './state/scenario';
import { useNarrative, type RespData } from './state/responsibilityData';

const PAGE = 50;

const monthDesc = (a: JoinedRow, b: JoinedRow) => (b.month ?? '').localeCompare(a.month ?? '') || a.report_id.localeCompare(b.report_id);

const hv = (v: string | null) => humanize(v).replace(/\bSuv\b/, 'SUV');

function keyFields(r: JoinedRow): string {
  const c = r.rec;
  if (!c) return 'Structured fields not published for this report';
  const hit = zonesOf(c, 'sv').map((z) => ZONE_LABEL[z]).join(', ');
  return [`Hit: ${hv(c.crash_with)}`, `Subject: ${hv(c.sv_movement)}`, `Struck at: ${hit || 'not reported'}`].join(' · ');
}

export function LabelCell({ r, mode }: { r: Pick<JoinedRow, 'label' | 'program'>; mode: Mode }) {
  return (
    <span className="label-cell">
      <i className="swatch" style={{ background: colorOf(LABEL_COLOR[r.label], mode) }} aria-hidden="true" /> {labelName(r.label, r.program)}
    </span>
  );
}

export function CrashList({ all, resp, f, mode }: { all: JoinedRow[]; resp: RespData; f: RespFilters; mode: Mode }) {
  const params = useQuery();
  const key = [f.programs.join(), f.severities.join(), f.from, f.to, f.label, f.rule, f.flow].join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => applyFilters(all, f).sort(monthDesc), [all, key]);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(params.get('rpg')) || 1));
  const shown = list.slice((page - 1) * PAGE, page * PAGE);
  const openId = params.get('rd');
  const open = useMemo(() => (openId ? all.find((r) => r.report_id === openId) ?? null : null), [all, openId]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `autonomous-safety-inferred-labels-${list.length}-reports.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const setPage = (p: number) => setQuery({ rpg: p <= 1 ? null : String(p) });
  const active: { text: string; clear: () => void }[] = [];
  if (f.label) active.push({ text: `Label: ${LABEL_KEY_NAME[f.label] ?? labelName(f.label as never)}`, clear: () => setQuery({ rl: null, rpg: null }) });
  if (f.rule) active.push({ text: `Rule: ${f.rule}`, clear: () => setQuery({ rr: null, rpg: null }) });
  if (f.flow) active.push({ text: `Flow: ${f.flow.split('|').map((x) => x.slice(x.indexOf(':') + 1)).join(' → ')}`, clear: () => setQuery({ rf: null, rpg: null }) });

  return (
    <div id="resp-list" className="resp-list">
      <h3>Reports in this view</h3>
      <p className="count" aria-live="polite" data-testid="resp-list-count">
        <b>{fmt(list.length)}</b> report-labels match the controls above{active.length ? ' and the list filters' : ''}
        <button type="button" className="btn" style={{ marginLeft: 12 }} onClick={download} disabled={list.length === 0}>Download CSV ({fmt(list.length)} rows)</button>
      </p>
      {active.length > 0 && (
        <p className="small resp-active">
          List filters:{' '}
          {active.map((a) => (
            <span key={a.text} className="fchip on">
              {a.text}
              <button type="button" className="link-on" onClick={a.clear} aria-label={`Remove filter ${a.text}`}>&times;</button>
            </span>
          ))}
        </p>
      )}
      <div className="table-wrap">
        <table className="rates-table resp-table">
          <caption className="sr-only">Inferred labels, one row per report. Select a report id to open its detail.</caption>
          <thead>
            <tr>
              <th scope="col">Report</th>
              <th scope="col">Program</th>
              <th scope="col">Month</th>
              <th scope="col">Inferred label</th>
              <th scope="col">Confidence</th>
              <th scope="col">Basis</th>
              <th scope="col">Rule</th>
              <th scope="col">Severity</th>
              <th scope="col">Key fields</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.report_key} className={openId === r.report_id ? 'on' : ''}>
                <td className="mono"><button type="button" className="link plain" onClick={() => setQuery({ rd: r.report_id })} aria-label={`Open report ${r.report_id}`}>{r.report_id}</button></td>
                <td>{PROGRAM_BY_KEY[r.program]?.short ?? r.program}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.month ?? 'n/a'}</td>
                <td><LabelCell r={r} mode={mode} /></td>
                <td>{CONFIDENCE_NAME[r.confidence]}</td>
                <td>{r.basis}</td>
                <td className="mono"><button type="button" className="link plain" title="Show only this rule" onClick={() => setQuery({ rr: r.rule, rpg: null })}>{r.rule}</button></td>
                <td>{SEVERITY_LABEL[r.severity] ?? r.severity}</td>
                <td className="small">{keyFields(r)}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={9}>No reports match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Pages of reports">
        <button type="button" className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span aria-live="polite">Page {fmt(page)} of {fmt(pages)}, {PAGE} per page</span>
        <button type="button" className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </nav>
      {open && <Drawer row={open} resp={resp} mode={mode} onClose={() => setQuery({ rd: null })} />}
    </div>
  );
}

function fmtValue(v: unknown): string {
  if (v == null) return 'not reported';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none listed';
  return String(v);
}

function Drawer({ row, resp, mode, onClose }: { row: JoinedRow; resp: RespData; mode: Mode; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const narr = useNarrative(row.report_id);
  const rule = resp.rules.rules.find((r) => r.id === row.rule);
  const hint = row.agent_hint ? resp.rules.agent_hints[row.agent_hint] : null;
  const evidence = evidenceFor(row);
  const rec = row.rec as unknown as Record<string, unknown> | null;

  useEffect(() => {
    close.current?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, row.report_id]);

  return (
    <aside className="drawer resp-drawer" role="dialog" aria-label={`Report ${row.report_id}: inferred label detail`}>
      <div className="drawer-head">
        <h3>Report {row.report_id}</h3>
        <button ref={close} type="button" onClick={onClose} aria-label="Close details">Close</button>
      </div>
      <p className="small resp-note">Inferred, not a finding of fault. NHTSA records no fault.</p>
      <dl>
        <div><dt>Program</dt><dd>{PROGRAM_BY_KEY[row.program]?.label ?? row.program}</dd></div>
        <div><dt>Incident month</dt><dd>{row.month ?? 'Not reported'}</dd></div>
        <div><dt>Inferred label</dt><dd><LabelCell r={row} mode={mode} /></dd></div>
        <div><dt>Confidence</dt><dd>{CONFIDENCE_NAME[row.confidence]}</dd></div>
        <div><dt>Basis</dt><dd>{row.basis === 'field' ? 'Structured report fields' : 'A readable narrative'}</dd></div>
        <div><dt>Rule</dt><dd className="mono">{row.rule}</dd></div>
        <div><dt>Injury severity</dt><dd>{SEVERITY_LABEL[row.severity] ?? row.severity} <span className="small">(highest in the incident)</span></dd></div>
      </dl>

      <h4>Why this label</h4>
      <p className="small">{rule ? rule.description : 'No description for this rule in the published rules file.'}</p>
      {hint && <p className="small"><b>Agent:</b> {hint}</p>}

      <h4>Evidence fields</h4>
      {evidence.length > 0 ? (
        <ul className="evidence">
          {evidence.map((e) => <li key={e.field}><code>{e.field}={e.value}</code></li>)}
        </ul>
      ) : (
        <p className="small">The structured fields for this report are not published: it is not its incident&rsquo;s primary report in records.json. The label was still computed from them.</p>
      )}

      <h4>Full structured record</h4>
      {rec ? (
        <dl className="record">
          {Object.entries(rec).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{fmtValue(v)}</dd></div>)}
        </dl>
      ) : (
        <p className="small">Not published for this report (see above). Severity is the incident&rsquo;s.</p>
      )}

      <h4>Narrative</h4>
      {narr.status === 'loading' && <p className="small" role="status">Loading narratives (about 4 MB, once)&hellip;</p>}
      {narr.status === 'error' && <p className="error small">Could not load the narratives ({narr.message}).</p>}
      {narr.status === 'redacted' && <p className="small narrative-redacted" data-testid="narrative">Redacted by the reporting company (no narrative text is published for this report).</p>}
      {narr.status === 'text' && <pre className="narrative" data-testid="narrative">{narr.text}</pre>}
    </aside>
  );
}
