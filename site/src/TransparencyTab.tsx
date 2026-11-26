import { useMemo, useState } from 'react';
import type { Data } from './data';
import { fmt, pct } from './data';
import { EChart, SourceNote } from './EChart';
import { FIELD_LABEL, PROGRAMS, ui, type Mode } from './theme';

type Metric = 'withheld' | 'unknown' | 'redacted' | 'provided';
const METRICS: { id: Metric; label: string; blurb: string }[] = [
  { id: 'withheld', label: 'Unknown or redacted', blurb: 'Share of reports where the answer is missing: unknown, blank or redacted.' },
  { id: 'unknown', label: 'Unknown', blurb: 'Share of reports where the filer answered "unknown" or left it blank.' },
  { id: 'redacted', label: 'Redacted', blurb: 'Share of reports where the filer withheld the answer as confidential business information.' },
  { id: 'provided', label: 'Provided', blurb: 'Share of reports with a real answer.' },
];

const ORANGE_LIGHT = ['#fdf1e9', '#f7c4a6', '#eb6834', '#b9400f', '#7a2807'];
const ORANGE_DARK = ['#2a1d17', '#6e3a1f', '#d95926', '#f0a07c', '#fbd9c6'];
const BLUE_LIGHT = ['#eef4fd', '#9ec5f4', '#3987e5', '#1c5cab', '#0d366b'];
const BLUE_DARK = ['#1b2430', '#1f4a80', '#2a78d6', '#6da7ec', '#cde2fb'];

export function TransparencyTab({ data, mode }: { data: Data; mode: Mode }) {
  const t = ui(mode);
  const tr = data.transparency;
  const [metric, setMetric] = useState<Metric>('withheld');
  const programs = PROGRAMS.filter((p) => tr.programs.includes(p.key));

  const option = useMemo(() => {
    const value = (p: string, f: string): number | null => {
      const c = tr.cells[p][f];
      if (!c || !c.n) return null;
      if (metric === 'withheld') return (c.unknown ?? 0) + (c.redacted ?? 0);
      return c[metric];
    };
    const cells: { value: [number, number, number | string]; label?: { color: string } }[] = [];
    programs.forEach((p, r) =>
      tr.fields.forEach((f, col) => {
        const v = value(p.key, f);
        cells.push({ value: [col, r, v == null ? '-' : v] });
      }),
    );
    const ramp = metric === 'provided' ? (mode === 'dark' ? BLUE_DARK : BLUE_LIGHT) : mode === 'dark' ? ORANGE_DARK : ORANGE_LIGHT;
    for (const c of cells) {
      const dark = typeof c.value[2] === 'number' && c.value[2] > 0.55;
      c.label = { color: mode === 'dark' ? (dark ? '#1a1008' : '#ecebe8') : dark ? '#ffffff' : '#15191d' };
    }
    return {
      animation: false,
      grid: { left: 108, right: 6, top: 118, bottom: 4 },
      tooltip: {
        confine: true,
        formatter: (p: { value: [number, number, number | string] }) => {
          const prog = programs[p.value[1]];
          const f = tr.fields[p.value[0]];
          const c = tr.cells[prog.key][f];
          if (!c.n) return `${prog.short} · ${FIELD_LABEL[f]}<br/>Not collected for this program's reports`;
          return (
            `${prog.short} · ${FIELD_LABEL[f]}<br/>` +
            `Provided <b>${pct(c.provided ?? 0, 1)}</b><br/>Unknown <b>${pct(c.unknown ?? 0, 1)}</b><br/>` +
            `Redacted <b>${pct(c.redacted ?? 0, 1)}</b><br/>of ${fmt(c.n)} reports`
          );
        },
      },
      xAxis: {
        type: 'category',
        position: 'top',
        data: tr.fields.map((f) => FIELD_LABEL[f]),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink, fontSize: 10.5, interval: 0, rotate: 50 },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: programs.map((p) => p.short),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink, fontSize: 12 },
      },
      visualMap: { show: false, min: 0, max: 1, inRange: { color: ramp }, dimension: 2, outOfRange: { color: t.grid } },
      series: [
        {
          type: 'heatmap',
          data: cells,
          itemStyle: { borderColor: t.surface, borderWidth: 1.5, borderRadius: 2 },
          label: {
            show: true,
            fontSize: 9.5,
            color: t.ink,
            formatter: (p: { value: [number, number, number | string] }) =>
              typeof p.value[2] === 'string' ? '' : p.value[2] >= 0.995 ? '100' : String(Math.round((p.value[2] as number) * 100)),
          },
        },
      ],
    };
  }, [tr, programs, metric, mode, t]);

  return (
    <section>
      <h2>What each program leaves out</h2>
      <p className="prose">
        For every field NHTSA asks for, how often did each program's reports give a real answer? Gaps matter because
        they limit what anyone, including this dashboard, can say about a company. Cells show whole percents.
      </p>
      <div className="controls row">
        <fieldset className="seg">
          <legend className="sr-only">Measure</legend>
          {METRICS.map((m) => (
            <button key={m.id} className={metric === m.id ? 'on' : ''} aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </fieldset>
      </div>
      <p className="prose small">{METRICS.find((m) => m.id === metric)!.blurb}</p>
      <EChart height={118 + 4 + programs.length * 36} label="Heatmap of missing information by program and field" option={option} />
      <p className="prose small">
        * Lighting, road surface and speed limit are only collected in reports filed through 2025-06-15. Their shares
        use only those older reports, and are blank where a program has none. Share is of reports (latest version of
        each), not of unique crashes.
      </p>
      <SourceNote date={data.meta.fetched_date} />
    </section>
  );
}
