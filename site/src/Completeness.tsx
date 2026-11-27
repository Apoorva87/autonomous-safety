import { useEffect, useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { fmt } from './data';
import { EChart } from './EChart';
import { PROGRAMS, PROGRAM_BY_KEY, SEVERITY_LABEL, colorOf, ui, type Mode } from './theme';
import { esc } from './lib/format';
import { FIELD_NAME, dumbbell, lateBySeverity, medianGap, revisionSeries, type RevisionsFile } from './lib/reporting';
import { KIND_GROUPS } from './lib/kinds';
import { useRatesData, type LagFile } from './data/rates';
import { setQuery, useQuery } from './state/scenario';

const base = import.meta.env.BASE_URL;
let revCache: Promise<RevisionsFile> | null = null;
function useRevisions(): { rev: RevisionsFile | null; error: string | null } {
  const [rev, setRev] = useState<RevisionsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    revCache ??= fetch(`${base}data/revisions.json`).then((r) => {
      if (!r.ok) throw new Error(`revisions.json: HTTP ${r.status}`);
      return r.json() as Promise<RevisionsFile>;
    });
    revCache.then(setRev, (e) => {
      revCache = null;
      setError(String(e));
    });
  }, []);
  return { rev, error };
}

const pctText = (x: number | null | undefined, d = 0) => (x == null ? 'n/a' : (x * 100).toFixed(d) + '%');

/** Transparency: reporting completeness and revisions, and how late reports arrive. */
export function Completeness({ mode, lastMonth }: { mode: Mode; lastMonth: string | null }) {
  const { rev, error } = useRevisions();
  const { rates } = useRatesData();
  const params = useQuery();
  const program = PROGRAM_BY_KEY[params.get('cp') ?? ''] ? (params.get('cp') as string) : 'tesla_l2';
  if (error) return <p className="error">Could not load revisions.json ({error}).</p>;
  if (!rev) return <p className="loading">Loading report revisions…</p>;
  const programs = PROGRAMS.map((p) => p.key).filter((k) => rev.rows.some((r) => r.program === k && r.reports >= 20));
  return (
    <div className="completeness">
      <h3>Reporting completeness and revisions</h3>
      <p className="prose">
        A report can be updated by later versions. For some filers the first version is a stub and the detail (pre-crash movement, crash partner, road type) arrives in a revision.
        When a filer stops revising, its reports keep the stub&rsquo;s unknowns, and every chart that uses those fields shifts for that reason alone.
      </p>
      <div className="grid-panels">
        {programs.map((p) => <RevisionPanel key={p} program={p} rev={rev} mode={mode} lastMonth={lastMonth} />)}
      </div>
      <ul className="legend rates-legend">
        <li><span className="swatch" style={{ background: ui(mode).ink }} /> solid: share of reports with a follow-up version (by incident quarter), 95% band</li>
        <li><span className="mk mk-late" /> dashed: share whose latest version has movement, partner and road type all unknown</li>
        <li><span className="mk mk-area" /> shaded: the last 12 months, which have had less time to be revised</li>
      </ul>

      <h4 className="small-h">What a revision fills in</h4>
      <div className="controls">
        <label className="field">
          Program
          <select value={program} onChange={(e) => setQuery({ cp: e.target.value === 'tesla_l2' ? null : e.target.value })}>
            {programs.map((p) => <option key={p} value={p}>{PROGRAM_BY_KEY[p].short}</option>)}
          </select>
        </label>
      </div>
      <Dumbbell rev={rev} program={program} mode={mode} />

      <div className="callout small" role="note">
        <b>What this does to every type and responsibility trend.</b> For Tesla Level 2, nearly every 2021-22 report was revised and about 1 in 100 from 2026. Revised reports had the pre-crash
        movement unknown about 9 times in 10 in their first version and about 2 in 10 in their latest; reports never revised keep the first version&rsquo;s unknowns. So from 2024 Q2 the share of Tesla reports with movement, partner and road type
        all unknown rose from about 3% to 37-41%. Any Tesla share computed over all reports (impact zone, movement, road type, &ldquo;cannot tell&rdquo; in the Responsibility tab) falls or
        rises with this practice, not with how the vehicles crashed. Use shares among reports where the field is known, and even then remember which reports carry fields changed.
      </div>

      {rates && <LateBySeverity lag={rates.lagFile} mode={mode} />}
    </div>
  );
}

function RevisionPanel({ program, rev, mode, lastMonth }: { program: string; rev: RevisionsFile; mode: Mode; lastMonth: string | null }) {
  const t = ui(mode);
  const color = colorOf(PROGRAM_BY_KEY[program].color, mode);
  const pts = useMemo(() => revisionSeries(rev.rows, program, 'quarter').filter((p) => p.reports > 0), [rev, program]);
  const gap = medianGap(rev.rows, program);
  const option = useMemo((): EChartsCoreOption => {
    const cats = pts.map((p) => p.period);
    const recentFrom = lastMonth ? `${Number(lastMonth.slice(0, 4)) - 1}-Q${Math.floor((Number(lastMonth.slice(5, 7)) - 1) / 3) + 1}` : null;
    const ri = recentFrom ? cats.findIndex((c) => c > recentFrom) : -1;
    const ok = (p: (typeof pts)[number]) => p.reports >= 10;
    return {
      animation: false, textStyle: { color: t.muted },
      grid: { left: 36, right: 8, top: 8, bottom: 22 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (ps: any) => {
          const p = pts[ps[0].dataIndex as number];
          return `<div style="font-size:12.5px"><b>${esc(PROGRAM_BY_KEY[program].short)}, ${esc(p.period)}</b><br>${fmt(p.reports)} reports<br>Revised: <b>${pctText(p.revised?.[0])}</b> (95% ${pctText(p.revised?.[1])} to ${pctText(p.revised?.[2])}), mean ${p.meanVersions?.toFixed(2)} versions<br>Movement, partner and road all unknown: ${pctText(p.allUnknown?.[0])}</div>`;
        },
      },
      xAxis: { type: 'category', data: cats, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
        axisLabel: { color: t.muted, fontSize: 9.5, interval: 0, formatter: (v: string) => (v.endsWith('Q1') ? "'" + v.slice(2, 4) : '') } },
      yAxis: { type: 'value', min: 0, max: 100, interval: 25, axisLabel: { color: t.muted, fontSize: 9.5, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        { type: 'line', data: pts.map((p) => (ok(p) && p.revised ? p.revised[1] * 100 : null)), stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, connectNulls: false,
          markArea: ri >= 0 ? { silent: true, itemStyle: { color: t.faint, opacity: 0.18 }, data: [[{ xAxis: cats[ri] }, { xAxis: cats[cats.length - 1] }]] } : undefined },
        { type: 'line', data: pts.map((p) => (ok(p) && p.revised ? (p.revised[2] - p.revised[1]) * 100 : null)), stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.22 }, silent: true, connectNulls: false },
        { name: 'Revised', type: 'line', data: pts.map((p) => (ok(p) && p.revised ? p.revised[0] * 100 : null)), symbol: 'circle', symbolSize: 4, lineStyle: { color, width: 2 }, itemStyle: { color }, connectNulls: false },
        { name: 'All unknown', type: 'line', data: pts.map((p) => (ok(p) && p.allUnknown ? p.allUnknown[0] * 100 : null)), symbol: 'none', lineStyle: { color: t.ink, width: 1.5, type: 'dashed' }, connectNulls: false },
      ],
    } as EChartsCoreOption;
  }, [pts, color, t, program, lastMonth]);
  const total = pts.reduce((a, p) => a + p.reports, 0);
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title"><i className="swatch" style={{ background: color }} /> {PROGRAM_BY_KEY[program].short}</span>
        <span className="panel-total"><span>{fmt(total)} reports{gap != null ? ` · median ${gap} month${gap === 1 ? '' : 's'} from first to latest version` : ''}</span></span>
      </figcaption>
      <EChart option={option} height={150} label={`${PROGRAM_BY_KEY[program].label}: share of reports revised and share with movement, partner and road type all unknown, by incident quarter`} />
    </figure>
  );
}

function Dumbbell({ rev, program, mode }: { rev: RevisionsFile; program: string; mode: Mode }) {
  const t = ui(mode);
  const rows = dumbbell(rev, program);
  const n = rows[0]?.n ?? 0;
  if (n < 20) return <p className="small">{PROGRAM_BY_KEY[program].short}: only {n} revised reports, too few to compare versions.</p>;
  const color = colorOf(PROGRAM_BY_KEY[program].color, mode);
  return (
    <>
      <p className="small">Share of fields reported unknown in the <b>first</b> version (hollow) and the <b>latest</b> version (filled) of the {fmt(n)} revised {PROGRAM_BY_KEY[program].short} reports. Right: the same share among the {fmt(rows[0].singleN)} reports never revised.</p>
      <ul className="dumbbell">
        {rows.map((r) => (
          <li key={r.field}>
            <span>{FIELD_NAME[r.field] ?? r.field}</span>
            <span className="db-track" role="img" aria-label={`${FIELD_NAME[r.field] ?? r.field}: unknown in ${pctText(r.first)} of first versions and ${pctText(r.latest)} of latest versions`}>
              <i className="nd-grid" style={{ left: '0%' }} /><i className="nd-grid" style={{ left: '50%' }} /><i className="nd-grid" style={{ left: '100%' }} />
              <i className="db-line" style={{ left: `${Math.min(r.first, r.latest) * 100}%`, width: `${Math.abs(r.first - r.latest) * 100}%` }} />
              <i className="db-dot" style={{ left: `${r.first * 100}%`, background: t.surface, borderColor: color }} />
              <i className="db-dot" style={{ left: `${r.latest * 100}%`, background: color, borderColor: color }} />
            </span>
            <span className="small">{pctText(r.first)} → {pctText(r.latest)} · never revised: {pctText(r.single)}</span>
          </li>
        ))}
      </ul>
      <p className="small">Scale 0 to 100%. Recent incidents have had less time to be revised, but most revisions arrive within a few months, so waiting is unlikely to fill in the recent stubs.</p>
    </>
  );
}

function LateBySeverity({ lag, mode }: { lag: LagFile; mode: Mode }) {
  const t = ui(mode);
  return (
    <>
      <h3>Serious crashes are filed later</h3>
      <p className="prose small">
        Share of reports filed two or more months after the incident month, by injury severity, per kind group and reporting regime (lag is in whole months: NHTSA publishes only the incident month and
        the submission month). Because serious and fatal crashes arrive later, the most recent months undercount them most. The late-report adjustment on the Rates tab uses each regime&rsquo;s own completeness
        curve (chain-ladder, months 0 to 12), never a pooled one.
      </p>
      <div className="grid-panels">
        {KIND_GROUPS.map((g) => (
          <figure key={g.id} className="panel">
            <figcaption><span className="panel-title">{g.label}</span><span className="panel-total">filed more than a month late, 95% interval</span></figcaption>
            <ul className="night-dots late-dots">
              {(['none', 'minor', 'moderate', 'serious', 'fatal', 'unknown'] as const).map((sev) => {
                const hists = g.programs.map((p) => lag.programs[p]?.hist).filter(Boolean) as LagFile['programs'][string]['hist'][];
                const pre = lateBySeverity(hists, 'pre').find((r) => r.severity === sev)!;
                const post = lateBySeverity(hists, 'post').find((r) => r.severity === sev)!;
                return (
                  <li key={sev}>
                    <span className="nd-name">{SEVERITY_LABEL[sev]}</span>
                    <span className="nd-track" aria-hidden="true">
                      {[0, 25, 50, 75, 100].map((x) => <i key={x} className="nd-grid" style={{ left: `${x}%` }} />)}
                      {[pre, post].map((r, i) => r.late && r.n >= 20 ? (
                        <span key={i} className="nd-mark" style={{ top: i === 0 ? '30%' : '70%' }}>
                          <i className="nd-ci" style={{ left: `${r.late[1] * 100}%`, width: `${(r.late[2] - r.late[1]) * 100}%`, background: t.ink }} />
                          <i className="nd-dot" style={{ left: `${r.late[0] * 100}%`, borderColor: t.ink, background: i === 1 ? t.ink : t.surface }} />
                        </span>
                      ) : null)}
                    </span>
                    <span className="nd-val small">
                      <span>before: {pre.late && pre.n >= 20 ? `${pctText(pre.late[0])} of ${fmt(pre.n)}` : `too few (${pre.n})`}</span>
                      <span>after: {post.late && post.n >= 20 ? `${pctText(post.late[0])} of ${fmt(post.n)}` : `too few (${post.n})`}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        ))}
      </div>
      <p className="small">Hollow: reports filed under the rules before 2025-06-16; filled: after. Scale 0 to 100%. The after-change regime is short, so its long lags are still being observed.</p>
    </>
  );
}
