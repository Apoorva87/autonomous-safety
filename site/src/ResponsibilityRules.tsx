import { useMemo } from 'react';
import { fmt } from './data';
import { PROGRAM_BY_KEY, PROGRAMS, LABEL_COLOR, colorOf, type Mode } from './theme';
import { CANNOT_NAME, CONFIDENCE_NAME, OTHER_NAME, comparisonStrip, labelName, type RespRow } from './lib/responsibility';
import type { RespData } from './state/responsibilityData';

const pct = (x: number, d = 0) => (x * 100).toFixed(d) + '%';

/** Comparison strip: ADS programs only, where narratives are readable. Tesla Level 2 is explicitly not like for like. */
export function ComparisonStrip({ rows, resp }: { rows: RespRow[]; resp: RespData }) {
  const strip = useMemo(() => comparisonStrip(rows), [rows]);
  const tesla = useMemo(() => {
    const t = resp.rows.filter((r) => r.program === 'tesla_l2');
    return t.length ? t.filter((r) => r.label === 'indeterminate').length / t.length : null;
  }, [resp.rows]);
  return (
    <div className="resp-strip">
      <h3>Comparing driverless (ADS) programs</h3>
      <p className="prose small">
        For each ADS program, the share of its reports labelled <b>{OTHER_NAME}</b> with <b>high confidence</b>. ADS companies file readable narratives for nearly every report, so the audit below can check their labels; that is what makes this comparison fair, and what Tesla Level 2 lacks.
      </p>
      {strip.length === 0 ? (
        <p className="callout small">No ADS reports in this view.</p>
      ) : (
        <div className="table-wrap">
          <table className="strip-table">
            <caption className="sr-only">Other party with high confidence, by ADS program</caption>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col" className="num">Reports in view</th>
                <th scope="col" className="num">Readable narratives (all reports, audit)</th>
                <th scope="col" className="num">Other party, high confidence</th>
                <th scope="col" className="num">Audit: narrative cue agrees</th>
              </tr>
            </thead>
            <tbody>
              {strip.map((c) => {
                const a = resp.audit.comparison[c.program];
                return (
                  <tr key={c.program}>
                    <th scope="row">{PROGRAM_BY_KEY[c.program]?.short ?? c.program}</th>
                    <td className="num">{fmt(c.all)}</td>
                    <td className="num">{a ? fmt(a.readable_narratives) : 'n/a'}</td>
                    <td className="num">{c.all >= 10 ? <><b>{pct(c.allOtherHigh / c.all)}</b> <span className="small">({fmt(c.allOtherHigh)} of {fmt(c.all)})</span></> : <span className="small">too few ({fmt(c.all)})</span>}</td>
                    <td className="num">{a?.agreement_rate != null ? `${pct(a.agreement_rate, 1)} (${fmt(a.agree)} of ${fmt(a.agree + a.disagree)})` : 'n/a'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="callout small resp-tesla-note" role="note">
        <b>Tesla Level 2 is not like for like.</b> Most Tesla Level 2 reports have unknown movement or contact fields and a redacted narrative, so {tesla == null ? 'many' : pct(tesla)} of them (all Tesla Level 2 reports, not just this view) are &ldquo;{CANNOT_NAME}&rdquo; and almost none can be checked against a narrative.
        Level 2 programs also cannot separate the human driver from the system. A lower &ldquo;{OTHER_NAME}&rdquo; share for Tesla Level 2 mostly reflects missing fields, not different driving, so it is left out of this comparison.
      </p>
    </div>
  );
}

export function RulesAndAudit({ resp, rows, mode, onRule, onOpen }: { resp: RespData; rows: RespRow[]; mode: Mode; onRule: (id: string) => void; onOpen: (reportId: string) => void }) {
  const byRule = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.rule, (m.get(r.rule) ?? 0) + 1);
    return m;
  }, [rows]);
  const { rules, audit } = resp;
  const agg = PROGRAMS.map((p) => p.key).filter((k) => audit.comparison[k]);

  return (
    <div id="resp-rules" className="resp-rules">
      <h3>The rules</h3>
      <p className="prose">
        Rules are tried in order and the first match wins. Each reads only structured fields (the narrative rule RESP-NAR-1 is the single exception and applies only where a narrative is readable).
        A rule&rsquo;s label is about the subject vehicle&rsquo;s own report and is never a finding of fault. Select a rule id to list the reports it labelled in the current view.
      </p>
      <div className="table-wrap">
        <table className="rates-table">
          <caption className="sr-only">Responsibility rules, version {rules.rules_version}</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Label</th>
              <th scope="col">Confidence</th>
              <th scope="col">Basis</th>
              <th scope="col">What it says</th>
              <th scope="col" className="num">Reports in view</th>
            </tr>
          </thead>
          <tbody>
            {rules.rules.map((r) => (
              <tr key={r.id}>
                <td className="mono"><button type="button" className="link plain" onClick={() => onRule(r.id)} aria-label={`List reports labelled by rule ${r.id}`}>{r.id}</button></td>
                <td><span className="swatch" style={{ background: colorOf(LABEL_COLOR[r.label], mode) }} aria-hidden="true" /> {r.label === 'subject_vehicle_initiated' ? 'Own motion' : labelName(r.label)}</td>
                <td>{CONFIDENCE_NAME[r.confidence]}</td>
                <td>{r.id === 'RESP-NAR-1' ? 'narrative' : 'field'}</td>
                <td className="small">{r.description}</td>
                <td className="num">{fmt(byRule.get(r.id) ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        For Level 2 programs an own-motion label carries the agent hint &ldquo;{rules.agent_hints.driver_or_system}&rdquo; For ADS programs: &ldquo;{rules.agent_hints.ads}&rdquo;
      </p>

      <h4>Retired rules</h4>
      <div className="table-wrap">
        <table className="rates-table">
          <caption className="sr-only">Retired rules</caption>
          <thead>
            <tr><th scope="col">Rule</th><th scope="col">Label it gave</th><th scope="col">Confidence</th><th scope="col">Retired in</th><th scope="col">What it said</th><th scope="col">Why it was retired</th></tr>
          </thead>
          <tbody>
            {rules.retired_rules.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>{r.label === 'subject_vehicle_initiated' ? 'Own motion' : labelName(r.label)}</td>
                <td>{CONFIDENCE_NAME[r.confidence]}</td>
                <td>rules v{r.retired_in}</td>
                <td className="small">{r.description}</td>
                <td className="small">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Audit against narratives</h3>
      <p className="callout small">
        <b>Read this audit as a smoke test, not as accuracy.</b> The audit looks for a few crude phrases in readable narratives ({Object.values(audit.cues).flat().map((c) => `“${c}”`).join(', ')}) and checks whether a narrative cue
        contradicts the label. &ldquo;Agree&rdquo; only means <b>no obvious contradiction</b>; it does not mean the label is correct, and a narrative can contain cues for both sides. Most narratives are redacted or have no cue, so most reports are not checked at all.
      </p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Agreement between labels and narrative cues, by program</caption>
          <thead>
            <tr>
              <th scope="col">Program</th>
              <th scope="col" className="num">Readable narratives</th>
              <th scope="col" className="num">With a comparable cue</th>
              <th scope="col" className="num">No obvious contradiction</th>
              <th scope="col" className="num">Disagree</th>
              <th scope="col" className="num">Rate</th>
            </tr>
          </thead>
          <tbody>
            {agg.map((k) => {
              const a = audit.comparison[k];
              return (
                <tr key={k}>
                  <th scope="row">{PROGRAM_BY_KEY[k]?.short ?? k}</th>
                  <td className="num">{fmt(a.readable_narratives)}</td>
                  <td className="num">{fmt(a.agree + a.disagree)}</td>
                  <td className="num">{fmt(a.agree)}</td>
                  <td className="num">{fmt(a.disagree)}</td>
                  <td className="num">{a.agreement_rate == null ? 'n/a (too few)' : pct(a.agreement_rate, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">Tesla Level 2 has only {fmt(audit.comparison.tesla_l2?.readable_narratives ?? 0)} readable narratives, so it is effectively unaudited.</p>

      <h4>Disagreement examples</h4>
      <p className="small">Reports where a narrative cue points the other way from the label. Select a report id to read it.</p>
      <div className="table-wrap">
        <table className="rates-table">
          <caption className="sr-only">Disagreement examples</caption>
          <thead><tr><th scope="col">Report</th><th scope="col">Program</th><th scope="col">Rule</th><th scope="col">Why it was flagged</th></tr></thead>
          <tbody>
            {audit.disagreement_examples.map((e) => (
              <tr key={e.report_key}>
                <td className="mono"><button type="button" className="link plain" onClick={() => onOpen(e.report_id)} aria-label={`Open report ${e.report_id}`}>{e.report_id}</button></td>
                <td>{PROGRAM_BY_KEY[e.program]?.short ?? e.program}</td>
                <td className="mono"><button type="button" className="link plain" onClick={() => onRule(e.rule)}>{e.rule}</button></td>
                <td className="small">{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
