import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart, SourceNote } from './EChart';
import { PROGRAMS, PROGRAM_BY_KEY, SEVERITY_LABEL, SEVERITY_ORDER, LABEL_COLOR, colorOf, ui, type Mode } from './theme';
import { ChipGroup } from './components/ChipGroup';
import { esc } from './lib/format';
import { textOn } from './lib/ramp';
import {
  BANNER, CANNOT_NAME, COLUMNS, COLUMN_TITLE, CONFIDENCE_NAME, LABELS, NODE_NAME, OTHER_NAME, OWN_ADS, OWN_L2,
  aggregateByProgram, applyControls, buildSankey, isL2, joinRows, labelName, multiProgramIncidents, periodRange, periodShare, timeSeries,
  type Confidence, type Grain, type JoinedRow, type Label, type ProgramAgg, type RespFilters, type SankeyGraph,
} from './lib/responsibility';
import { BREAK_DATE } from './lib/metrics';
import { setQuery, useQuery } from './state/scenario';
import { getList, toggleIn } from './state/viewstate';
import { useResponsibility, type RespData } from './state/responsibilityData';
import { ComparisonStrip, RulesAndAudit } from './ResponsibilityRules';
import { CrashList } from './ResponsibilityList';

const pctText = (x: number, d = 0) => (x * 100).toFixed(d) + '%';

export function Responsibility({ data, mode }: { data: Data; mode: Mode }) {
  const { resp, error } = useResponsibility();
  if (error) return <p className="error">Could not load the responsibility files ({error}).</p>;
  if (!resp) return <p className="loading">Loading the inferred labels…</p>;
  return <Loaded data={data} resp={resp} mode={mode} />;
}

function Loaded({ data, resp, mode }: { data: Data; resp: RespData; mode: Mode }) {
  const params = useQuery();
  const all = useMemo(() => joinRows(resp.rows, data.crashes), [resp.rows, data.crashes]);
  const months = useMemo(() => [...new Set(all.map((r) => r.month).filter((m): m is string => !!m))].sort(), [all]);

  const f: RespFilters = {
    programs: getList(params, 'rp').filter((p) => PROGRAM_BY_KEY[p]),
    severities: getList(params, 'rsv'),
    from: params.get('rm0') ?? '',
    to: params.get('rm1') ?? '',
    label: params.get('rl') ?? '',
    rule: params.get('rr') ?? '',
    flow: params.get('rf') ?? '',
  };
  const share = params.get('rv') !== 'n';
  const grain: Grain = params.get('rt') === 'y' ? 'year' : 'month';

  const key = [f.programs.join(), f.severities.join(), f.from, f.to].join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => applyControls(all, f), [all, key]);
  const agg = useMemo(() => aggregateByProgram(rows), [rows]);
  const overlap = useMemo(() => multiProgramIncidents(rows), [rows]);
  const graph = useMemo(() => buildSankey(rows), [rows]);

  const resetList = { rl: null, rr: null, rf: null, rpg: null, rd: null };
  const setControl = (updates: Record<string, string | null>) => setQuery({ ...updates, ...resetList });
  const anyControl = f.programs.length > 0 || f.severities.length > 0 || !!f.from || !!f.to;
  const clearAll = () => setQuery({ rp: null, rsv: null, rm0: null, rm1: null, ...resetList });

  const scrollTo = (id: string) => window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }), 30);
  const pickSegment = (program: string, label: Label) => {
    setQuery({ rp: program, rl: label, rr: null, rf: null, rpg: null, rd: null });
    scrollTo('resp-list');
  };
  const pickFlow = (id: string) => {
    setQuery({ rf: f.flow === id ? null : id, rl: null, rr: null, rpg: null, rd: null });
    scrollTo('resp-list');
  };

  return (
    <section className="responsibility">
      <h2>Responsibility: who initiated the contact (inferred)</h2>
      <div className="callout resp-banner" role="note">
        <b>{BANNER(resp.rulesVersion)}</b>
      </div>
      <p className="prose">
        Each report gets one label about <b>its own vehicle</b>, from a fixed list of rules that read the structured fields (pre-crash movements, contact areas, what was hit, speed). The labels:
        {' '}<b>{OTHER_NAME}</b>, <b>Own motion</b> and <b>{CANNOT_NAME}</b>. For driver-assist (Level 2) programs own motion reads &ldquo;{OWN_L2}&rdquo;; for driverless (ADS) programs it reads &ldquo;{OWN_ADS}&rdquo;.
        Every label carries a <b>confidence</b> (high, medium, low) and a <b>basis</b> (a structured field, or a readable narrative). Counts are <b>per report-label</b>, not per crash:
        {overlap > 0 && <> {fmt(overlap)} incident{overlap === 1 ? '' : 's'} in this view {overlap === 1 ? 'is' : 'are'} reported under more than one program (each company reports its own vehicle), so programs overlap and <b>are never summed</b>.</>}
      </p>

      <div className="rates-controls impact-controls">
        <ChipGroup
          legend="Program"
          options={PROGRAMS.map((p) => ({ value: p.key, label: p.short, color: colorOf(p.color, mode) }))}
          selected={f.programs}
          onToggle={(v) => setControl({ rp: toggleIn(f.programs, v).join(',') || null })}
          onClear={() => setControl({ rp: null })}
        />
        <ChipGroup
          legend="Injury severity (of the crash)"
          options={SEVERITY_ORDER.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
          selected={f.severities}
          onToggle={(v) => setControl({ rsv: toggleIn(f.severities, v).join(',') || null })}
          onClear={() => setControl({ rsv: null })}
        />
        <label className="field">
          <span>From month</span>
          <select value={f.from} onChange={(e) => setControl({ rm0: e.target.value || null })}>
            <option value="">Start</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">
          <span>To month</span>
          <select value={f.to} onChange={(e) => setControl({ rm1: e.target.value || null })}>
            <option value="">Latest</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <div className="field">
          <span>Show</span>
          <div className="seg" role="group" aria-label="Shares or counts">
            <button type="button" className={share ? 'on' : ''} aria-pressed={share} onClick={() => setQuery({ rv: null })}>Share of reports</button>
            <button type="button" className={!share ? 'on' : ''} aria-pressed={!share} onClick={() => setQuery({ rv: 'n' })}>Count of reports</button>
          </div>
        </div>
      </div>
      <p className="count" aria-live="polite" data-testid="resp-count">
        <b>{fmt(rows.length)}</b> of {fmt(all.length)} report-labels in view
        {anyControl && (
          <button type="button" className="link" onClick={clearAll}>Clear filters</button>
        )}
      </p>

      <h3>Share of each program&rsquo;s reports by inferred label</h3>
      <LabelBars agg={agg} share={share} mode={mode} rows={rows} onPick={pickSegment} />

      <ComparisonStrip rows={rows} resp={resp} />

      <h3>Flow: from engagement to inferred label</h3>
      <Flow graph={graph} selected={f.flow} mode={mode} onPick={pickFlow} />

      <h3>Over time</h3>
      <TimePanels rows={rows} share={share} grain={grain} mode={mode} />

      <CrashList all={all} resp={resp} f={f} mode={mode} />

      <RulesAndAudit resp={resp} rows={rows} mode={mode} onRule={(id) => { setQuery({ rr: id, rl: null, rf: null, rpg: null, rd: null }); scrollTo('resp-list'); }} onOpen={(id) => { setQuery({ rd: id }); scrollTo('resp-list'); }} />

      <SourceNote
        date={data.meta.fetched_date}
        extra={`Labels: ${resp.labelSet}, rules v${resp.rulesVersion}, one per current NHTSA SGO report. Structured fields come from records.json (each incident's primary report); narratives are read only when you open a report.`}
      />
    </section>
  );
}

// ------------------------------------------------------------------ bars

const BAR_SERIES: { label: Label; conf: Confidence }[] = [
  { label: 'other_party', conf: 'high' },
  { label: 'other_party', conf: 'medium' },
  { label: 'subject_vehicle_initiated', conf: 'high' },
  { label: 'subject_vehicle_initiated', conf: 'medium' },
  { label: 'indeterminate', conf: 'low' },
];

function segStyle(label: Label, conf: Confidence, mode: Mode): React.CSSProperties {
  const c = colorOf(LABEL_COLOR[label], mode);
  if (conf === 'high') return { background: c, color: textOn(c) };
  // Medium and low confidence: a tint of the same hue with diagonal stripes in the full colour.
  return {
    backgroundColor: `color-mix(in srgb, ${c} 30%, var(--surface))`,
    backgroundImage: `repeating-linear-gradient(135deg, ${c} 0 2px, transparent 2px 6px)`,
    boxShadow: `inset 0 0 0 1.5px ${c}`,
    color: 'var(--ink)',
  };
}
// Cannot tell is always low confidence by construction, so it is drawn solid (a gray fill) and labelled; its confidence is stated in the legend.
function segStyleFor(label: Label, conf: Confidence, mode: Mode): React.CSSProperties {
  if (label === 'indeterminate') {
    const c = colorOf(LABEL_COLOR.indeterminate, mode);
    return { background: c, color: textOn(c) };
  }
  return segStyle(label, conf, mode);
}

function LabelBars({ agg, share, mode, rows, onPick }: { agg: ProgramAgg[]; share: boolean; mode: Mode; rows: JoinedRow[]; onPick: (program: string, label: Label) => void }) {
  const maxTotal = Math.max(1, ...agg.map((a) => a.total));
  const tesla = agg.find((a) => a.program === 'tesla_l2');
  const teslaRows = useMemo(() => (tesla ? rows.filter((r) => r.program === 'tesla_l2') : []), [rows, tesla]);
  const teslaInd1 = teslaRows.filter((r) => r.rule === 'RESP-IND-1').length;
  const teslaReadable = teslaRows.filter((r) => r.rec && !r.rec.narrative_redacted).length;
  const teslaInd = tesla?.labelTotal.indeterminate ?? 0;

  if (agg.length === 0) return <p className="callout small">No reports match these controls.</p>;
  return (
    <div className="resp-bars">
      <ul className="legend resp-legend" aria-label="Legend">
        <li><span className="seg-key" style={segStyleFor('other_party', 'high', mode)} /> {OTHER_NAME}, high confidence</li>
        <li><span className="seg-key" style={segStyleFor('other_party', 'medium', mode)} /> {OTHER_NAME}, medium (striped)</li>
        <li><span className="seg-key" style={segStyleFor('subject_vehicle_initiated', 'high', mode)} /> Own motion, high</li>
        <li><span className="seg-key" style={segStyleFor('subject_vehicle_initiated', 'medium', mode)} /> Own motion, medium (striped)</li>
        <li><span className="seg-key" style={segStyleFor('indeterminate', 'low', mode)} /> {CANNOT_NAME} (always low confidence)</li>
      </ul>
      <ul className="resp-rows">
        {agg.map((a) => {
          const info = PROGRAM_BY_KEY[a.program];
          const l2 = isL2(a.program);
          const track = share ? 100 : (a.total / maxTotal) * 100;
          return (
            <li key={a.program} className="resp-row">
              <span className="resp-name">
                <i className="swatch" style={{ background: colorOf(info.color, mode) }} /> <b>{info.short}</b>
                <span className="small"> {l2 ? 'Level 2' : 'ADS'}, {fmt(a.total)} reports</span>
              </span>
              <span className="resp-track" role="group" aria-label={`${info.label}: ${fmt(a.total)} reports`}>
                <span className="resp-fill" style={{ width: `${track}%` }}>
                  {BAR_SERIES.map(({ label, conf }) => {
                    const n = a.counts[label][conf];
                    if (n === 0) return null;
                    const w = (n / a.total) * 100;
                    const text = `${labelName(label, a.program)}, ${CONFIDENCE_NAME[conf].toLowerCase()} confidence: ${fmt(n)} reports, ${pctText(n / a.total, 1)} of ${info.short}`;
                    return (
                      <button
                        key={label + conf}
                        type="button"
                        className="resp-seg"
                        style={{ width: `${w}%`, ...segStyleFor(label, conf, mode) }}
                        title={text}
                        aria-label={`${text}. Show these reports in the list.`}
                        onClick={() => onPick(a.program, label)}
                      >
                        {w >= 8 && conf !== 'medium' ? (share ? pctText(n / a.total) : fmt(n)) : ''}
                      </button>
                    );
                  })}
                </span>
              </span>
              <span className="resp-ind" title={`${fmt(a.labelTotal.indeterminate)} of ${fmt(a.total)} reports`}>
                <b>{pctText(a.share.indeterminate)}</b> cannot tell
                <span className="small"> ({fmt(a.labelTotal.indeterminate)})</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="small">
        Own motion reads &ldquo;{OWN_L2}&rdquo; for Level 2 programs and &ldquo;{OWN_ADS}&rdquo; for ADS programs (hover a segment for the exact wording). Click a segment to list its reports.
        {share ? ' Every bar is 100% of that program’s reports.' : ' Bar length is the report count, so programs of different size differ in length: counts are not comparable across programs.'}
        {' '}Labels describe each report&rsquo;s own vehicle; a crash reported by two companies has a label under each.
      </p>
      {tesla && (
        <div className="callout why-no-data" role="note">
          <b>Tesla Level 2: {pctText(tesla.share.indeterminate, 0)} cannot tell.</b> This is a limit of the report fields, not a finding.
          {' '}{fmt(teslaInd1)} of {fmt(teslaInd)} Tesla Level 2 reports in view (rule RESP-IND-1) have an unknown or missing pre-crash movement or contact area, so no rule can apply, and
          only {fmt(teslaReadable)} of {fmt(tesla.total)} have a readable narrative (the rest are redacted), so the narrative audit says almost nothing about them.
          Compare Tesla Level 2 with other programs only with this in mind.
        </div>
      )}
      <details className="table-view">
        <summary>Show the numbers as a table</summary>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Reports by program, label and confidence</caption>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col" className="num">Reports</th>
                <th scope="col" className="num">Other party, high</th>
                <th scope="col" className="num">Other party, medium</th>
                <th scope="col" className="num">Own motion, high</th>
                <th scope="col" className="num">Own motion, medium</th>
                <th scope="col" className="num">Cannot tell (low)</th>
              </tr>
            </thead>
            <tbody>
              {agg.map((a) => (
                <tr key={a.program}>
                  <th scope="row">{PROGRAM_BY_KEY[a.program].short}</th>
                  <td className="num">{fmt(a.total)}</td>
                  <td className="num">{fmt(a.counts.other_party.high)}</td>
                  <td className="num">{fmt(a.counts.other_party.medium)}</td>
                  <td className="num">{fmt(a.counts.subject_vehicle_initiated.high)}</td>
                  <td className="num">{fmt(a.counts.subject_vehicle_initiated.medium)}</td>
                  <td className="num">{fmt(a.counts.indeterminate.low)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">No total row: programs overlap for incidents reported by more than one company.</p>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ flow

function nodeColor(id: string, mode: Mode): string {
  const t = ui(mode);
  if (id.startsWith('lb:')) {
    const k = id.slice(3);
    return colorOf(LABEL_COLOR[k === 'other_party' ? 'other_party' : k === 'indeterminate' ? 'indeterminate' : 'subject_vehicle_initiated'], mode);
  }
  return id.startsWith('eng:') ? t.ink : t.muted;
}

export function sankeyOption(g: SankeyGraph, selected: string, mode: Mode, narrow: boolean): EChartsCoreOption {
  const t = ui(mode);
  const sel = selected ? selected.split('|') : [];
  const isNodeSel = (id: string) => sel.length === 1 && sel[0] === id;
  const isLinkSel = (s: string, d: string) => sel.length === 2 && sel[0] === s && sel[1] === d;
  const total = Math.max(1, g.drawn);
  return {
    animation: false,
    textStyle: { color: t.muted },
    tooltip: {
      trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
      formatter: (p: any) =>
        p.dataType === 'edge'
          ? `<div style="font-size:12.5px;max-width:260px;white-space:normal">${esc(NODE_NAME(p.data.source))} &rarr; ${esc(NODE_NAME(p.data.target))}<br><b>${fmt(p.data.value)}</b> reports (${pctText(p.data.value / total, 1)} of those drawn)<br><i>Click to list them</i></div>`
          : `<div style="font-size:12.5px;max-width:260px;white-space:normal"><b>${esc(NODE_NAME(p.name))}</b><br>${fmt(p.value)} reports (${pctText(p.value / total, 1)} of those drawn)<br><i>Click to list them</i></div>`,
    },
    series: [
      {
        type: 'sankey', orient: 'horizontal', left: 6, right: narrow ? 210 : 270, top: 22, bottom: 6, nodeWidth: 14, nodeGap: 7, nodeAlign: 'justify',
        draggable: false, emphasis: { focus: 'adjacency' },
        label: { color: t.ink, fontSize: 11, backgroundColor: mode === 'dark' ? 'rgba(21,24,27,0.78)' : 'rgba(255,255,255,0.82)', padding: [1, 3], borderRadius: 3, formatter: (p: any) => `${NODE_NAME(p.name)} ${fmt(p.value)}` },
        data: g.nodes.map((n) => ({
          name: n.id, depth: n.col, value: n.value,
          itemStyle: { color: nodeColor(n.id, mode), borderColor: isNodeSel(n.id) ? t.brand : 'transparent', borderWidth: isNodeSel(n.id) ? 3 : 0 },
        })),
        links: g.links.map((l) => ({
          source: l.source, target: l.target, value: l.value,
          lineStyle: {
            color: l.target.startsWith('lb:') ? nodeColor(l.target, mode) : t.faint,
            opacity: isLinkSel(l.source, l.target) ? 0.85 : l.target.startsWith('lb:') ? 0.5 : 0.3,
          },
        })),
        lineStyle: { curveness: 0.5 },
      },
    ],
  } as EChartsCoreOption;
}

function Flow({ graph, selected, mode, onPick }: { graph: SankeyGraph; selected: string; mode: Mode; onPick: (id: string) => void }) {
  const narrow = typeof window !== 'undefined' && window.innerWidth < 600;
  const option = useMemo(() => sankeyOption(graph, selected, mode, narrow), [graph, selected, mode, narrow]);
  const handlers = {
    click: (p: any) => {
      if (p.dataType === 'node') onPick(p.name);
      else if (p.dataType === 'edge') onPick(`${p.data.source}|${p.data.target}`);
    },
  };
  const selText = selected ? selected.split('|').map(NODE_NAME).join(' → ') : '';
  return (
    <figure className="panel resp-flow">
      <figcaption>
        <span className="panel-title">{COLUMNS.map((c) => COLUMN_TITLE[c]).join(' → ')}</span>
        <span className="panel-total">Each report is one path left to right. Width is the number of reports. Click a block or a flow to list its reports below.</span>
      </figcaption>
      {graph.drawn === 0 ? (
        <p className="callout small">No reports with structured fields in this view.</p>
      ) : (
        <div className="scroll-x">
          <div style={{ minWidth: 800 }}>
            <EChart option={option} height={narrow ? 520 : 560} label={`Flow diagram of ${fmt(graph.drawn)} reports from engagement, subject vehicle movement, what was hit and impact point to the inferred label`} onEvents={handlers} />
          </div>
        </div>
      )}
      {selected && <p className="small">Flow selected: <b>{selText}</b> (listed below; click it again to clear).</p>}
      <p className="small">
        {fmt(graph.drawn)} reports drawn; {fmt(graph.skipped)} left out because they are not their incident&rsquo;s primary report, so their structured fields are not published in records.json.
        Own motion is split by program kind so its wording stays exact. Movement, partner and impact point are grouped; &ldquo;Unknown&rdquo; blocks are what the filing says (or leaves blank), not data lost in this chart.
      </p>
      <details className="table-view">
        <summary>Show the flows as a table</summary>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Flows between columns</caption>
            <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" className="num">Reports</th></tr></thead>
            <tbody>
              {graph.links.slice(0, 60).map((l) => (
                <tr key={l.source + l.target}>
                  <td>{NODE_NAME(l.source)}</td>
                  <td>{NODE_NAME(l.target)}</td>
                  <td className="num">{fmt(l.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">The 60 largest of {fmt(graph.links.length)} flows.</p>
      </details>
    </figure>
  );
}

// ------------------------------------------------------------------ over time

const MIN_SHARE_N = 10;

function TimePanels({ rows, share, grain, mode }: { rows: JoinedRow[]; share: boolean; grain: Grain; mode: Mode }) {
  const programs = useMemo(() => PROGRAMS.map((p) => p.key).filter((k) => rows.some((r) => r.program === k)), [rows]);
  const periods = useMemo(() => periodRange(rows.map((r) => r.month ?? ''), grain), [rows, grain]);
  const series = useMemo(() => programs.map((p) => ({ p, ts: timeSeries(rows.filter((r) => r.program === p), periods, grain) })), [rows, programs, periods, grain]);
  const t = ui(mode);
  const breakAt = grain === 'year' ? BREAK_DATE.slice(0, 4) : BREAK_DATE.slice(0, 7);
  const breakIdx = periods.indexOf(breakAt);

  const optionFor = (p: string, ts: (typeof series)[number]['ts']): EChartsCoreOption => {
    const mk = (label: Label) => ({
      name: labelName(label, p), type: 'bar', stack: 'n', barCategoryGap: grain === 'year' ? '30%' : '8%',
      itemStyle: { color: colorOf(LABEL_COLOR[label], mode) },
      data: share ? periodShare(ts, label, MIN_SHARE_N).map((v) => (v == null ? null : v * 100)) : ts.counts[label],
      ...(label === 'other_party' && breakIdx >= 0
        ? { markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 1.5 }, data: [{ xAxis: breakIdx }] } }
        : {}),
    });
    return {
      animation: false, textStyle: { color: t.muted },
      grid: { left: 40, right: 8, top: 8, bottom: 22 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (ps: any) => {
          const i = ps[0].dataIndex as number;
          const n = ts.totals[i];
          const rowsHtml = LABELS.map((l) => `<div>${esc(labelName(l, p))}: <b>${fmt(ts.counts[l][i])}</b>${n ? ` (${pctText(ts.counts[l][i] / n)})` : ''}</div>`).join('');
          return `<div style="font-size:12.5px;max-width:260px;white-space:normal"><b>${esc(PROGRAM_BY_KEY[p].short)}, ${esc(ts.periods[i])}</b><br>${fmt(n)} reports${share && n < MIN_SHARE_N ? ` (under ${MIN_SHARE_N}: share not drawn)` : ''}${rowsHtml}</div>`;
        },
      },
      xAxis: {
        type: 'category', data: ts.periods, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
        axisLabel: { color: t.muted, fontSize: 10, interval: 0, formatter: (v: string) => (grain === 'year' ? v : v.endsWith('-01') ? v.slice(0, 4) : '') },
      },
      yAxis: { type: 'value', min: 0, max: share ? 100 : undefined, axisLabel: { color: t.muted, fontSize: 10, formatter: share ? '{value}%' : '{value}' }, splitLine: { lineStyle: { color: t.grid } } },
      series: LABELS.map(mk),
    } as EChartsCoreOption;
  };

  return (
    <div>
      <div className="controls">
        <div className="field">
          <span>Group by</span>
          <div className="seg" role="group" aria-label="Month or year">
            <button type="button" className={grain === 'month' ? 'on' : ''} aria-pressed={grain === 'month'} onClick={() => setQuery({ rt: null })}>Month</button>
            <button type="button" className={grain === 'year' ? 'on' : ''} aria-pressed={grain === 'year'} onClick={() => setQuery({ rt: 'y' })}>Year</button>
          </div>
        </div>
        <ul className="legend resp-legend" aria-label="Legend">
          {LABELS.map((l) => (
            <li key={l}><span className="seg-key" style={{ background: colorOf(LABEL_COLOR[l], mode) }} /> {l === 'subject_vehicle_initiated' ? 'Own motion' : labelName(l)}</li>
          ))}
          <li><span className="mk mk-break" /> 2025-06-16 SGO rule change</li>
        </ul>
      </div>
      {series.length === 0 ? (
        <p className="callout small">No reports in view.</p>
      ) : (
        <div className="grid-panels">
          {series.map(({ p, ts }) => (
            <figure key={p} className="panel">
              <figcaption>
                <span className="panel-title"><i className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[p].color, mode) }} /> {PROGRAM_BY_KEY[p].short}</span>
                <span className="panel-total">{fmt(ts.totals.reduce((a, b) => a + b, 0))} dated reports</span>
              </figcaption>
              <EChart option={optionFor(p, ts)} height={170} label={`${PROGRAM_BY_KEY[p].label}: inferred labels by ${grain}, ${share ? 'share' : 'count'}`} />
            </figure>
          ))}
        </div>
      )}
      <p className="small">
        {share
          ? `Shares of each ${grain}’s reports; ${grain === 'year' ? 'years' : 'months'} with under ${MIN_SHARE_N} reports are left blank because a share of so few is noise.`
          : 'Counts. Each panel has its own scale, and counts are not comparable across programs (different fleet sizes, reporting duties and years in service).'}
        {' '}Own motion reads &ldquo;{OWN_L2}&rdquo; for Level 2 and &ldquo;{OWN_ADS}&rdquo; for ADS programs (see the tooltip). The dashed line is the 2025-06-16 change in NHTSA reporting rules (reporting thresholds changed), so a step there is not by itself a change in driving.
        Reports are placed by incident month; recent months are still filling in.
      </p>
    </div>
  );
}
