import { useEffect, useMemo, useState } from 'react';
import type { Data } from './data';
import { fmt, pct } from './data';
import { EChart, SourceNote } from './EChart';
import { KindCaveat } from './components/KindCaveat';
import { PROGRAMS, TAG_LABEL, TAG_ORDER, ui, type Mode } from './theme';
import { setQuery, useQuery } from './state/scenario';
import { MixView } from './MixView';
import { TimeOfDay } from './TimeOfDay';
import { RegimeBadge } from './components/Regime';

/** True below `px` CSS pixels (updates on resize). */
export function useNarrow(px = 600): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < px);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < px);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [px]);
  return narrow;
}

const VIEWS = [
  { id: 'tags', label: 'Pattern tags' },
  { id: 'mix', label: 'Incident mix over time' },
  { id: 'time', label: 'Time of day' },
] as const;
type RegimeSel = 'all' | 'pre' | 'post';
const inRegime = (m: string | null, r: RegimeSel) => r === 'all' || (!!m && (r === 'pre' ? m < '2025-06' : m > '2025-06'));

const RAMP_LIGHT = ['#eef4fd', '#9ec5f4', '#3987e5', '#1c5cab', '#0d366b'];
const RAMP_DARK = ['#1b2430', '#1f4a80', '#2a78d6', '#6da7ec', '#cde2fb'];

export function Patterns({ data, mode }: { data: Data; mode: Mode }) {
  const params = useQuery();
  const sub = (VIEWS.find((v) => v.id === params.get('pv'))?.id ?? 'tags') as (typeof VIEWS)[number]['id'];
  return (
    <section>
      <h2>Patterns</h2>
      <div className="controls">
        <div className="seg" role="group" aria-label="Patterns view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={sub === v.id ? 'on' : ''} aria-pressed={sub === v.id} onClick={() => setQuery({ pv: v.id === 'tags' ? null : v.id })}>{v.label}</button>
          ))}
        </div>
      </div>
      {sub === 'tags' && <TagHeatmap data={data} mode={mode} />}
      {sub === 'mix' && <MixView data={data} mode={mode} />}
      {sub === 'time' && <TimeOfDay data={data} mode={mode} />}
    </section>
  );
}

function TagHeatmap({ data, mode }: { data: Data; mode: Mode }) {
  const t = ui(mode);
  const [view, setView] = useState<'count' | 'share'>('share');
  const [narrative, setNarrative] = useState(false);
  const params = useQuery();
  const regime = (['pre', 'post'].includes(params.get('pr') ?? '') ? params.get('pr') : 'all') as RegimeSel;
  const narrow = useNarrow();

  const stats = useMemo(() => {
    const programs = PROGRAMS.filter((p) => data.counts.programs.includes(p.key));
    const total: Record<string, number> = {};
    const redacted: Record<string, number> = {};
    const hit: Record<string, Record<string, { f: number; n: number }>> = {};
    for (const p of programs) {
      total[p.key] = 0;
      redacted[p.key] = 0;
      hit[p.key] = Object.fromEntries(TAG_ORDER.map((tg) => [tg, { f: 0, n: 0 }]));
    }
    for (const c of data.crashes) {
      if (!inRegime(c.month, regime)) continue;
      total[c.program]++;
      if (c.narrative_redacted) redacted[c.program]++;
      for (const tg of c.tags) {
        const [name, basis] = tg.split(':');
        hit[c.program][name][basis === 'f' ? 'f' : 'n']++;
      }
    }
    return { programs, total, redacted, hit };
  }, [data, regime]);

  const option = useMemo(() => {
    const { programs, total, hit } = stats;
    const cells: { value: [number, number, number, number]; label?: { color: string } }[] = [];
    let max = 0;
    programs.forEach((p, row) =>
      TAG_ORDER.forEach((tg, col) => {
        const h = hit[p.key][tg];
        const n = h.f + (narrative ? h.n : 0);
        // After 2025-06-15 Lighting is not collected, so the visibility tag cannot fire from it: blank, with the reason.
        const blank = tg === 'visibility_glare' && regime === 'post';
        const v = blank ? -1 : view === 'count' ? n : total[p.key] ? n / total[p.key] : 0;
        if (v > max) max = v;
        cells.push({ value: [col, row, v, n] });
      }),
    );
    const ramp = mode === 'dark' ? RAMP_DARK : RAMP_LIGHT;
    for (const c of cells) {
      const dark = c.value[2] / (max || 1) > 0.55;
      c.label = { color: mode === 'dark' ? (dark ? '#0b1a2e' : '#ecebe8') : dark ? '#ffffff' : '#15191d' };
    }
    return {
      animation: false,
      grid: { left: narrow ? 118 : 150, right: 10, top: narrow ? 104 : 78, bottom: 6 },
      tooltip: {
        confine: true,
        formatter: (p: { value: [number, number, number, number] }) => {
          const [c, r, v, n] = p.value;
          const prog = programs[r];
          if (v < 0) return `${prog.short} · ${TAG_LABEL[TAG_ORDER[c]]}<br/>Not comparable after 2025-06-15: the Lighting field this tag reads is no longer collected.`;
          return `${prog.short} · ${TAG_LABEL[TAG_ORDER[c]]}<br/><b>${fmt(n)}</b> of ${fmt(total[prog.key])} crashes (${pct(
            total[prog.key] ? n / total[prog.key] : 0,
            1,
          )})`;
        },
      },
      xAxis: {
        type: 'category',
        position: 'top',
        data: TAG_ORDER.map((k) => TAG_LABEL[k]),
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: narrow
          ? { color: t.ink, fontSize: 10, interval: 0, rotate: 50 }
          : { color: t.ink, fontSize: 11, interval: 0, width: 84, overflow: 'break' },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: programs.map((p) => `${p.short}  (${fmt(total[p.key])})`),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink, fontSize: narrow ? 11 : 12 },
      },
      visualMap: { show: false, min: 0, max: max || 1, inRange: { color: ramp }, dimension: 2, outOfRange: { color: t.grid } },
      series: [
        {
          type: 'heatmap',
          data: cells,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
          label: {
            show: true,
            fontSize: 11,
            formatter: (p: { value: [number, number, number, number] }) => {
              const v = p.value[2];
              if (v < 0) return 'n/c';
              return view === 'count' ? (v ? fmt(v) : '') : v ? pct(v, v < 0.1 ? 1 : 0) : '';
            },
            color: t.ink,
          },
        },
      ],
    };
  }, [stats, view, narrative, mode, t, regime, narrow]);

  const redactedRows = stats.programs
    .filter((p) => stats.total[p.key] > 0)
    .map((p) => ({ short: p.short, share: stats.redacted[p.key] / stats.total[p.key] }));

  return (
    <div>
      <h3>Failure patterns by program</h3>
      <p className="prose">
        Each crash gets zero or more plain-language tags from published rules (see Data &amp; sources). A tag is
        either decided by a structured NHTSA field (road type, lighting, movement) or by keywords in the written
        narrative.
      </p>
      <KindCaveat extra="Shares of a program's own crashes are comparable in kind, not across kinds: which crashes are reportable differs." />
      <div className="controls row">
        <fieldset className="seg">
          <legend className="sr-only">Cell value</legend>
          <button className={view === 'share' ? 'on' : ''} aria-pressed={view === 'share'} onClick={() => setView('share')}>
            Share of program's crashes
          </button>
          <button className={view === 'count' ? 'on' : ''} aria-pressed={view === 'count'} onClick={() => setView('count')}>
            Crash counts
          </button>
        </fieldset>
        <fieldset className="seg">
          <legend className="sr-only">Which months</legend>
          {(['all', 'pre', 'post'] as RegimeSel[]).map((r) => (
            <button key={r} className={regime === r ? 'on' : ''} aria-pressed={regime === r} onClick={() => setQuery({ pr: r === 'all' ? null : r })}>
              {r === 'all' ? 'All months' : r === 'pre' ? 'Before 2025-06-16' : 'After 2025-06-16'}
            </button>
          ))}
        </fieldset>
        <fieldset className="seg">
          <legend className="sr-only">Which tags to include</legend>
          <button className={!narrative ? 'on' : ''} aria-pressed={!narrative} onClick={() => setNarrative(false)}>
            Structured-field tags only
          </button>
          <button className={narrative ? 'on' : ''} aria-pressed={narrative} onClick={() => setNarrative(true)}>
            Include narrative tags
          </button>
        </fieldset>
      </div>
      <p><RegimeBadge /></p>
      {narrow && <p className="small scroll-hint">Scroll the heatmap sideways to see every tag.</p>}
      <div className="scroll-x">
        <div style={{ minWidth: narrow ? 560 : undefined }}>
          <EChart height={(narrow ? 104 : 78) + 6 + stats.programs.length * 46} label="Heatmap of failure-pattern tags by program" option={option} />
        </div>
      </div>
      <p className="prose small">
        {regime === 'post'
          ? 'n/c: not comparable. The reduced-visibility tag reads the Lighting field, which NHTSA stopped collecting on 2025-06-16, so after the change it can only fire from weather; the cell is left blank. The Time of day view shows the light condition derived from the incident time instead.'
          : regime === 'all'
            ? 'All months mixes the two reporting regimes: the reduced-visibility tag halves after 2025-06-15 only because Lighting stopped being collected, and minor crashes left the data at the same date. Pick a regime to compare like with like.'
            : 'Before 2025-06-16: the reporting rules and fields of the archive file.'}
      </p>
      <SourceNote date={data.meta.fetched_date} extra="Program-level crash records; a crash can carry several tags, so rows do not add to 100%." />

      <div className="callout">
        <h3>Why narrative tags are not a fair comparison</h3>
        <p>
          Narrative tags can only fire when a readable narrative exists. Tesla redacts nearly every narrative in its
          driver-assist (L2) reports as confidential business information, so its narrative-based tags are close to
          zero by construction, while
          Waymo publishes detailed ones. Switching narrative tags on therefore raises Waymo's numbers and barely
          changes Tesla's. That reflects who discloses, not who crashes more. Narratives redacted or blank:
        </p>
        <ul className="inline-list">
          {redactedRows.map((r) => (
            <li key={r.short}>
              <b>{r.short}</b> {pct(r.share, 2)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
