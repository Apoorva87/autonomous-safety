import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart, SourceNote } from './EChart';
import { PROGRAMS, PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { esc } from './lib/format';
import { DIMS, DIM_BY_ID, artifactsFor, mixSeries, type CategorySeries, type DimId, type MixPoint } from './lib/mix';
import { kindLabel, kindOf } from './lib/kinds';
import { setQuery, useQuery } from './state/scenario';
import { RegimeBadge } from './components/Regime';

const pctText = (x: number | null | undefined, d = 0) => (x == null ? 'n/a' : (x * 100).toFixed(d) + '%');
const BRK = (mode: Mode) => (mode === 'dark' ? '#e0693a' : '#b3361a');

/** Incident mix over time: one program, one field, half-year shares with Wilson bands, small multiples per category. */
export function MixView({ data, mode }: { data: Data; mode: Mode }) {
  const params = useQuery();
  const program = PROGRAM_BY_KEY[params.get('mp') ?? ''] ? (params.get('mp') as string) : 'waymo_ads';
  const dimId = (DIM_BY_ID[params.get('md') as DimId] ? params.get('md') : 'road') as DimId;
  const knownOnly = params.get('mk') !== 'all';
  const dim = DIM_BY_ID[dimId];
  const crashes = useMemo(() => data.crashes.filter((c) => c.program === program), [data.crashes, program]);
  const mix = useMemo(() => mixSeries(crashes, dim, { knownOnly }), [crashes, dim, knownOnly]);
  const artifacts = artifactsFor(program, dimId);
  const color = colorOf(PROGRAM_BY_KEY[program].color, mode);
  const kind = kindOf(program);

  return (
    <div className="mix-view">
      <p className="prose">
        Which crash types are becoming more or less common <em>within</em> one program? Each panel is one category, by half-year, with a Wilson 95% band.
        Shares of a program&rsquo;s own crashes are compared over time only; programs are never compared with each other here ({kind ? kindLabel(kind) : ''} reporting thresholds apply).
        Most visible shifts in this data are produced by reporting changes, listed above the panels; a shift is badged only when it is unlikely to be chance (p &lt; 0.001) <b>and</b> a trend of the same
        direction also exists inside one regime, so it is not just the step at the rule change.
      </p>
      <div className="controls">
        <label className="field">
          Program
          <select value={program} onChange={(e) => setQuery({ mp: e.target.value === 'waymo_ads' ? null : e.target.value })}>
            {PROGRAMS.map((p) => <option key={p.key} value={p.key}>{p.short}</option>)}
          </select>
        </label>
        <label className="field">
          Field
          <select value={dimId} onChange={(e) => setQuery({ md: e.target.value === 'road' ? null : e.target.value })}>
            {DIMS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        <div className="field">
          Denominator
          <div className="seg" role="group" aria-label="Denominator">
            <button type="button" className={knownOnly ? 'on' : ''} aria-pressed={knownOnly} onClick={() => setQuery({ mk: null })}>Among crashes where this field is known</button>
            <button type="button" className={!knownOnly ? 'on' : ''} aria-pressed={!knownOnly} onClick={() => setQuery({ mk: 'all' })}>Among all crashes (unknown included)</button>
          </div>
        </div>
      </div>
      <p><RegimeBadge /></p>
      <ul className="artifact-list" aria-label="Known reporting artifacts for this view">
        {artifacts.map((a) => <li key={a.id}><span className="artifact-badge">artifact from {a.from}</span> {a.text}</li>)}
      </ul>
      {dim.multi && <p className="small">A crash can carry several tags, so the shares do not add up to 100%.</p>}
      {mix.categories.length === 0 ? (
        <p className="callout small">No crashes with this field for {PROGRAM_BY_KEY[program].short}.</p>
      ) : (
        <div className="grid-panels mix-grid">
          {mix.categories.map((c) => (
            <CategoryPanel key={c.category} cat={c} periods={mix.periods} color={color} mode={mode} dashedAfterBreak={dimId === 'tag' && c.category.startsWith('Reduced visibility')}
              caution={program === 'tesla_l2' && dimId !== 'light'} />
          ))}
          {!dim.multi && <CategoryPanel cat={{ category: 'Unknown or not reported (share of all crashes)', points: mix.unknown, total: mix.unknown.reduce((a, p) => a + p.k, 0), shift: null }} periods={mix.periods} color={ui(mode).faint} mode={mode} area />}
        </div>
      )}
      <p className="small">
        Half-years with fewer than {mix.minN} crashes in the denominator have no point. Categories under 3% of the program&rsquo;s known crashes are folded into &ldquo;Other&rdquo;.
        The dashed line is the 2025-06-16 rule change; lines are not joined across the half-year that contains it (2025H1).
      </p>
      <SourceNote date={data.meta.fetched_date} extra="Program-level crash records (one per program and incident), by incident month." />
    </div>
  );
}

function CategoryPanel({ cat, periods, color, mode, dashedAfterBreak = false, area = false, caution = false }: { cat: CategorySeries; periods: string[]; color: string; mode: Mode; dashedAfterBreak?: boolean; area?: boolean; caution?: boolean }) {
  const t = ui(mode);
  const option = useMemo((): EChartsCoreOption => {
    const idx = periods.indexOf('2025H1');
    const v = (p: MixPoint, k: 'share' | 'lo' | 'hi') => (p[k] == null ? null : (p[k] as number) * 100);
    // Split the line at 2025H1 (the half-year containing the rule change stands alone).
    const seg = (keep: (i: number) => boolean) => cat.points.map((p, i) => (keep(i) ? v(p, 'share') : null));
    const pre = seg((i) => idx < 0 || i < idx);
    const mid = seg((i) => i === idx);
    const post = seg((i) => idx >= 0 && i > idx);
    const lo = cat.points.map((p) => v(p, 'lo'));
    const band = cat.points.map((p) => (p.hi == null || p.lo == null ? null : (p.hi - p.lo) * 100));
    const line = (data: (number | null)[], dashed = false) => ({
      type: 'line', data, connectNulls: false, symbol: 'circle', symbolSize: 5, lineStyle: { color, width: 2, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color },
      areaStyle: area ? { color, opacity: 0.35 } : undefined,
    });
    return {
      animation: false, textStyle: { color: t.muted },
      grid: { left: 36, right: 8, top: 10, bottom: 22 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (ps: any) => {
          const p = cat.points[ps[0].dataIndex as number];
          return `<div style="font-size:12.5px"><b>${esc(cat.category)}, ${esc(p.period)}</b><br>${p.share == null ? `${fmt(p.n)} crashes: too few for a share` : `${pctText(p.share, 1)} (95% ${pctText(p.lo)} to ${pctText(p.hi)})<br>${fmt(p.k)} of ${fmt(p.n)} crashes`}</div>`;
        },
      },
      xAxis: { type: 'category', data: periods, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
        axisLabel: { color: t.muted, fontSize: 9.5, interval: 0, formatter: (s: string) => (s.endsWith('H1') ? "'" + s.slice(2, 4) : '') } },
      yAxis: { type: 'value', min: 0, max: (x: { max: number }) => Math.min(100, Math.ceil((x.max + 5) / 10) * 10), axisLabel: { color: t.muted, fontSize: 9.5, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        ...(area ? [] : [
          { type: 'line', data: lo, stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, connectNulls: false, silent: true },
          { type: 'line', data: band, stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.2 }, connectNulls: false, silent: true },
        ]),
        { ...line(pre), markLine: idx >= 0 ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: BRK(mode), type: 'dashed', width: 1.5 }, data: [{ xAxis: idx }] } : undefined },
        line(mid),
        line(post, dashedAfterBreak),
      ],
    } as EChartsCoreOption;
  }, [cat, periods, color, mode, t, dashedAfterBreak, area]);
  const s = cat.shift;
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title">{cat.category}</span>
        <span className="panel-total">
          {s && s.verdict === 'survives' && (
            <span className="shift-badge">
              shift beyond the rule-change step ({pctText(s.pre)} → {pctText(s.post)}){caution ? ', but it coincides with Tesla’s 2024 reporting change (suggestive only)' : ', with a trend inside a regime'}
            </span>
          )}
          {s && s.verdict === 'step-only' && <span className="small">step at the rule change only ({pctText(s.pre)} → {pctText(s.post)}): likely the threshold change</span>}
          {(!s || s.verdict === 'none') && <span className="small">{fmt(cat.total)} crashes</span>}
        </span>
      </figcaption>
      <EChart option={option} height={150} label={`${cat.category}: share by half-year with 95% band`} />
    </figure>
  );
}
