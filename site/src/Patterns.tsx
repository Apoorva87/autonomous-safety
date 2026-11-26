import { useMemo, useState } from 'react';
import type { Data } from './data';
import { fmt, pct } from './data';
import { EChart, SourceNote } from './EChart';
import { PROGRAMS, TAG_LABEL, TAG_ORDER, ui, type Mode } from './theme';

const RAMP_LIGHT = ['#eef4fd', '#9ec5f4', '#3987e5', '#1c5cab', '#0d366b'];
const RAMP_DARK = ['#1b2430', '#1f4a80', '#2a78d6', '#6da7ec', '#cde2fb'];

export function Patterns({ data, mode }: { data: Data; mode: Mode }) {
  const t = ui(mode);
  const [view, setView] = useState<'count' | 'share'>('share');
  const [narrative, setNarrative] = useState(false);

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
      total[c.program]++;
      if (c.narrative_redacted) redacted[c.program]++;
      for (const tg of c.tags) {
        const [name, basis] = tg.split(':');
        hit[c.program][name][basis === 'f' ? 'f' : 'n']++;
      }
    }
    return { programs, total, redacted, hit };
  }, [data]);

  const option = useMemo(() => {
    const { programs, total, hit } = stats;
    const cells: { value: [number, number, number, number]; label?: { color: string } }[] = [];
    let max = 0;
    programs.forEach((p, row) =>
      TAG_ORDER.forEach((tg, col) => {
        const h = hit[p.key][tg];
        const n = h.f + (narrative ? h.n : 0);
        const v = view === 'count' ? n : total[p.key] ? n / total[p.key] : 0;
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
      grid: { left: 150, right: 10, top: 78, bottom: 6 },
      tooltip: {
        confine: true,
        formatter: (p: { value: [number, number, number, number] }) => {
          const [c, r, , n] = p.value;
          const prog = programs[r];
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
        axisLabel: {
          color: t.ink,
          fontSize: 11,
          interval: 0,
          width: 84,
          overflow: 'break',
        },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: programs.map((p) => `${p.short}  (${fmt(total[p.key])})`),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink, fontSize: 12 },
      },
      visualMap: { show: false, min: 0, max: max || 1, inRange: { color: ramp }, dimension: 2 },
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
              return view === 'count' ? (v ? fmt(v) : '') : v ? pct(v, v < 0.1 ? 1 : 0) : '';
            },
            color: t.ink,
          },
        },
      ],
    };
  }, [stats, view, narrative, mode, t]);

  const redactedRows = stats.programs
    .filter((p) => ['tesla_l2', 'tesla_robotaxi', 'waymo_ads', 'gm_supercruise', 'zoox_ads'].includes(p.key))
    .map((p) => ({ short: p.short, share: stats.redacted[p.key] / stats.total[p.key] }));

  return (
    <section>
      <h2>Failure patterns by program</h2>
      <p className="prose">
        Each crash gets zero or more plain-language tags from published rules (see Data &amp; sources). A tag is
        either decided by a structured NHTSA field (road type, lighting, movement) or by keywords in the written
        narrative.
      </p>
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
          <legend className="sr-only">Which tags to include</legend>
          <button className={!narrative ? 'on' : ''} aria-pressed={!narrative} onClick={() => setNarrative(false)}>
            Structured-field tags only
          </button>
          <button className={narrative ? 'on' : ''} aria-pressed={narrative} onClick={() => setNarrative(true)}>
            Include narrative tags
          </button>
        </fieldset>
      </div>
      <EChart height={78 + 6 + stats.programs.length * 46} label="Heatmap of failure-pattern tags by program" option={option} />
      <SourceNote date={data.meta.fetched_date} extra="Unique crashes; a crash can carry several tags, so rows do not add to 100%." />

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
    </section>
  );
}
