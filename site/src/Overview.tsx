import { useMemo, useState } from 'react';
import type { Data } from './data';
import { fmt } from './data';
import { EChart, SourceNote } from './EChart';
import {
  PROGRAMS,
  PROGRAM_BY_KEY,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  colorOf,
  ui,
  type Mode,
} from './theme';

const START = '2021-01'; // SGO reporting began mid-2021; earlier-dated crashes are counted in the footnote.

type Panel = { key: string; title: string; color: string; series: number[]; total: number; note?: string };

export function Overview({ data, mode }: { data: Data; mode: Mode }) {
  const { counts, crashes, meta } = data;
  const t = ui(mode);
  const [sameScale, setSameScale] = useState(false);
  const [entity, setEntity] = useState('Zoox, Inc.');

  const months = useMemo(() => counts.months.filter((m) => m >= START), [counts]);

  const entities = useMemo(() => {
    const c = new Map<string, number>();
    for (const x of crashes) if (x.company === 'zoox' || x.company === 'other') c.set(x.entity, (c.get(x.entity) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [crashes]);

  const outside = useMemo(() => {
    let early = 0;
    let undated = 0;
    for (const c of crashes) {
      if (!c.month) undated++;
      else if (c.month < START) early++;
    }
    return { early, undated };
  }, [crashes]);

  const panels: Panel[] = useMemo(() => {
    const programSeries = (keys: string[]) => {
      const bucket = months.map((m) => {
        let n = 0;
        for (const k of keys) for (const v of Object.values(counts.counts[k]?.[m] ?? {})) n += v;
        return n;
      });
      return bucket;
    };
    const mk = (key: string, keys: string[], title: string, color: string): Panel => {
      const series = programSeries(keys);
      return { key, title, color, series, total: series.reduce((a, b) => a + b, 0) };
    };
    const col = (k: string) => colorOf(PROGRAM_BY_KEY[k].color, mode);
    const base: Panel[] = ['tesla_l2', 'tesla_robotaxi', 'gm_supercruise', 'gm_cruise_ads', 'waymo_ads'].map((k) =>
      mk(k, [k], PROGRAM_BY_KEY[k].label, col(k)),
    );
    const idx = new Map(months.map((m, i) => [m, i]));
    const custom = new Array(months.length).fill(0);
    for (const c of crashes) if (c.entity === entity && c.month && idx.has(c.month)) custom[idx.get(c.month)!]++;
    base.push({
      key: 'custom',
      title: entity,
      color: colorOf(PROGRAM_BY_KEY[entity === 'Zoox, Inc.' ? 'zoox_ads' : 'other_ads'].color, mode),
      series: custom,
      total: custom.reduce((a: number, b: number) => a + b, 0),
      note: 'Pick any reporting entity',
    });
    base.push(mk('other', ['other_ads', 'other_l2'], 'All other reporters', col('other_ads')));
    return base;
  }, [counts, crashes, months, mode, entity]);

  const globalMax = Math.max(...panels.map((p) => Math.max(...p.series)));

  return (
    <section>
      <h2>Crashes per month, by program</h2>
      <p className="prose">
        Each bar is the number of unique crashes (reports of one crash are merged) with an incident in that month.
        Counts are not rates: programs differ enormously in miles driven and fleet size, which is why this preview does
        not rank them.
      </p>
      <div className="controls">
        <label className="check">
          <input type="checkbox" checked={sameScale} onChange={(e) => setSameScale(e.target.checked)} /> Same vertical
          scale on every panel
        </label>
      </div>

      <div className="grid-panels">
        {panels.map((p, i) => (
          <figure className="panel" key={p.key}>
            <figcaption>
              {p.key === 'custom' ? (
                <label className="entity-pick">
                  <span className="sr-only">Reporting entity for this panel</span>
                  <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Reporting entity">
                    {entities.map(([name, n]) => (
                      <option key={name} value={name}>
                        {name} ({fmt(n)})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="panel-title">{p.title}</span>
              )}
              <span className="panel-total">
                <i className="swatch" style={{ background: p.color }} /> {fmt(p.total)} crashes
              </span>
            </figcaption>
            <EChart
              height={150}
              label={`Monthly unique crashes, ${p.title}`}
              option={monthlyOption(months, p.series, p.color, t, sameScale ? globalMax : undefined, meta.structural_break, i === 0)}
            />
          </figure>
        ))}
      </div>
      <p className="prose small">
        Dashed line: 2025-06-16, when NHTSA's amended reporting rules took effect (thresholds and which crashes must be
        reported changed). A change across it is not a change in safety. The latest months are incomplete because
        reports arrive weeks later. {fmt(outside.early)} crashes dated before 2021 and {fmt(outside.undated)} with no
        valid date are not shown.
      </p>
      <SourceNote date={meta.fetched_date} extra="Unique crashes by incident month." />

      <h2>Injury severity mix</h2>
      <p className="prose">
        Highest injury level reported for each crash. Grey is "Unknown": either the filer did not know or the injury
        label was not given. The share of unknowns differs a lot between programs, so compare the colored parts with
        care.
      </p>
      <EChart
        height={330}
        label="Injury severity mix by program, share of unique crashes"
        option={severityOption(data, mode)}
      />
      <SourceNote date={meta.fetched_date} extra="Share of each program's unique crashes; hover for counts." />
    </section>
  );
}

function monthlyOption(
  months: string[],
  series: number[],
  color: string,
  t: ReturnType<typeof ui>,
  max: number | undefined,
  breakDate: string,
  labelBreak: boolean,
) {
  const breakMonth = breakDate.slice(0, 7);
  return {
    animation: false,
    grid: { left: 34, right: 8, top: 14, bottom: 22 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      confine: true,
      formatter: (p: { name: string; value: number }[]) => `${p[0].name}: <b>${p[0].value}</b> crashes`,
    },
    xAxis: {
      type: 'category',
      data: months,
      axisLine: { lineStyle: { color: t.rule } },
      axisTick: { show: false },
      axisLabel: {
        color: t.muted,
        fontSize: 10,
        interval: (_i: number, v: string) => v.endsWith('-01'),
        formatter: (v: string) => v.slice(0, 4),
      },
    },
    yAxis: {
      type: 'value',
      max,
      splitNumber: 3,
      axisLabel: { color: t.muted, fontSize: 10 },
      splitLine: { lineStyle: { color: t.grid } },
    },
    series: [
      {
        type: 'bar',
        data: series,
        barCategoryGap: '25%',
        itemStyle: { color, borderRadius: [2, 2, 0, 0] },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: t.muted, type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ xAxis: breakMonth }],
        },
      },
    ],
  };
}

function severityOption(data: Data, mode: Mode) {
  const t = ui(mode);
  const keys = PROGRAMS.map((p) => p.key).filter((k) => data.counts.programs.includes(k));
  const totals: Record<string, Record<string, number>> = {};
  for (const k of keys) {
    totals[k] = {};
    for (const month of Object.values(data.counts.counts[k] ?? {}))
      for (const [sev, n] of Object.entries(month)) totals[k][sev] = (totals[k][sev] ?? 0) + n;
  }
  const sum = (k: string) => Object.values(totals[k]).reduce((a, b) => a + b, 0);
  return {
    animation: false,
    grid: { left: 112, right: 12, top: 34, bottom: 8 },
    legend: { top: 0, textStyle: { color: t.ink, fontSize: 12 }, itemWidth: 12, itemHeight: 12, icon: 'roundRect' },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (p: { seriesName: string; name: string; value: number; data: { n: number } }) =>
        `${p.name}<br/>${p.seriesName}: <b>${fmt(p.data.n)}</b> crashes (${(p.value * 100).toFixed(1)}%)`,
    },
    xAxis: {
      type: 'value',
      max: 1,
      axisLabel: { color: t.muted, formatter: (v: number) => Math.round(v * 100) + '%' },
      splitLine: { lineStyle: { color: t.grid } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: keys.map((k) => PROGRAM_BY_KEY[k].short),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.ink, fontSize: 12 },
    },
    series: SEVERITY_ORDER.map((sev) => ({
      name: SEVERITY_LABEL[sev],
      type: 'bar',
      stack: 'sev',
      barWidth: 22,
      itemStyle: { color: colorOf(SEVERITY_COLOR[sev], mode), borderColor: t.surface, borderWidth: 1.5 },
      label: {
        show: true,
        fontSize: 10,
        color:
          sev === 'none' || sev === 'minor' || (sev === 'unknown' && mode === 'light') ? '#15191d' : '#ffffff',
        formatter: (p: { value: number }) => (p.value >= 0.08 ? Math.round(p.value * 100) + '%' : ''),
      },
      data: keys.map((k) => {
        const n = totals[k][sev] ?? 0;
        return { value: n / sum(k), n };
      }),
    })),
  };
}
