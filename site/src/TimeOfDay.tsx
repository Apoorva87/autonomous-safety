import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart, SourceNote } from './EChart';
import { PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { esc } from './lib/format';
import { KIND_GROUPS, type KindId } from './lib/kinds';
import { hourStats, type HourStats, type Regime } from './lib/timeOfDay';
import { setQuery, useQuery } from './state/scenario';
import { RegimeBadge } from './components/Regime';

const pctText = (x: number | null | undefined, d = 0) => (x == null ? 'n/a' : (x * 100).toFixed(d) + '%');
const REGIMES: { id: Regime; label: string }[] = [
  { id: 'all', label: 'All months' },
  { id: 'pre', label: 'Before 2025-06-16' },
  { id: 'post', label: 'After 2025-06-16' },
];
// Ordinal light classes: one hue, light to dark (day -> twilight -> night).
const LIGHT_RAMP = { light: ['#cfe1f8', '#6da7ec', '#1c5cab'], dark: ['#cde2fb', '#6da7ec', '#2a78d6'] };
const MIN_N = 30;

export function TimeOfDay({ data, mode }: { data: Data; mode: Mode }) {
  const params = useQuery();
  const regime = (REGIMES.find((r) => r.id === params.get('tr'))?.id ?? 'all') as Regime;
  const t = ui(mode);
  const stats = useMemo(() => {
    const out: Record<string, Record<Regime, HourStats>> = {};
    for (const g of KIND_GROUPS) for (const p of g.programs) {
      const cs = data.crashes.filter((c) => c.program === p);
      out[p] = { all: hourStats(cs, 'all'), pre: hourStats(cs, 'pre'), post: hourStats(cs, 'post') };
    }
    return out;
  }, [data.crashes]);

  return (
    <div className="tod-view">
      <p className="prose">
        When do reported crashes happen? Bars are each program&rsquo;s share of its crashes by local hour. <b>There is no exposure by hour</b> (nobody publishes miles by time of day), so this shows
        when reported crashes occur, not when driving is riskier: a program that drives mostly at night will have mostly night crashes. Reporting thresholds differ by kind group, so Level 2 and driverless
        programs are shown in separate panels and never compared.
      </p>
      <div className="callout small" role="note">
        <b>Tesla times are converted from UTC.</b> Tesla files incident times in UTC, every other reporter in local time. As filed, 42% of Tesla Level 2 crashes would fall between 21:00 and 06:00;
        converted to each report&rsquo;s local time it is about 27%. The conversion uses the state&rsquo;s main time zone and daylight saving time by month (dates are month-level), so a few crashes near a
        boundary may sit one hour off. Evidence and method: Data &amp; sources.
      </div>
      <div className="controls">
        <div className="field">
          Months
          <div className="seg" role="group" aria-label="Which months">
            {REGIMES.map((r) => (
              <button key={r.id} type="button" className={regime === r.id ? 'on' : ''} aria-pressed={regime === r.id} onClick={() => setQuery({ tr: r.id === 'all' ? null : r.id })}>{r.label}</button>
            ))}
          </div>
        </div>
      </div>
      <p><RegimeBadge /></p>

      {KIND_GROUPS.map((g) => (
        <KindPanel key={g.id} kind={g.id} programs={g.programs} stats={stats} regime={regime} mode={mode} />
      ))}

      <h3>Light condition, derived from time (approximate)</h3>
      <p className="prose small">
        Day, twilight (within an hour of sunrise or sunset) or night, from the local time and month with one US-wide sun table. The same rule applies before and after the change, so unlike the
        recorded Lighting field (collected only to 2025-06-15) it can be compared across it. Approximate: real light depends on the exact place and date, which the data does not give.
      </p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Derived light condition by program and regime</caption>
          <thead>
            <tr>
              <th scope="col">Program</th>
              {(['pre', 'post'] as const).map((r) => <th key={r} scope="col">{r === 'pre' ? 'Before 2025-06-16' : 'After 2025-06-16'}: day / twilight / night</th>)}
            </tr>
          </thead>
          <tbody>
            {KIND_GROUPS.flatMap((g) => g.programs).map((p) => (
              <tr key={p}>
                <th scope="row">{PROGRAM_BY_KEY[p].short}</th>
                {(['pre', 'post'] as const).map((r) => {
                  const s = stats[p][r];
                  if (s.lightN < MIN_N) return <td key={r} className="small">{fmt(s.lightN)} crashes: too few</td>;
                  return (
                    <td key={r}>
                      <LightBar s={s} mode={mode} />
                      <span className="small">{pctText(s.light.day / s.lightN)} / {pctText(s.light.twilight / s.lightN)} / {pctText(s.light.night / s.lightN)} of {fmt(s.lightN)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="legend rates-legend">
        {(['day', 'twilight', 'night'] as const).map((k, i) => <li key={k}><span className="swatch" style={{ background: LIGHT_RAMP[mode][i] }} /> {k}</li>)}
      </ul>
      <p className="small" style={{ color: t.muted }}>
        GM Cruise ran driverless service mostly at night, so its night share reflects when it operated. Tesla Robotaxi did not run overnight at first.
      </p>
      <SourceNote date={data.meta.fetched_date} extra="Incident time as filed (Tesla converted from UTC), program-level crash records." />
    </div>
  );
}

function LightBar({ s, mode }: { s: HourStats; mode: Mode }) {
  const parts = (['day', 'twilight', 'night'] as const).map((k, i) => ({ k, w: (s.light[k] / s.lightN) * 100, c: LIGHT_RAMP[mode][i] }));
  return (
    <span className="light-bar" aria-hidden="true">
      {parts.map((p) => <i key={p.k} style={{ width: `${p.w}%`, background: p.c }} />)}
    </span>
  );
}

function KindPanel({ kind, programs, stats, regime, mode }: { kind: KindId; programs: string[]; stats: Record<string, Record<Regime, HourStats>>; regime: Regime; mode: Mode }) {
  const t = ui(mode);
  const label = KIND_GROUPS.find((g) => g.id === kind)!.label;
  const shown = programs.filter((p) => stats[p][regime].n >= MIN_N);
  const hidden = programs.filter((p) => stats[p][regime].n < MIN_N);
  return (
    <section aria-label={`${label}: crashes by hour`}>
      <h3>{label}</h3>
      <div className="grid-panels">
        {shown.map((p) => <HourPanel key={p} program={p} s={stats[p][regime]} mode={mode} />)}
      </div>
      {hidden.length > 0 && <p className="small">Fewer than {MIN_N} crashes with a time{regime !== 'all' ? ' in these months' : ''}: {hidden.map((p) => `${PROGRAM_BY_KEY[p].short} (${stats[p][regime].n})`).join(', ')}.</p>}
      <h4 className="small-h">Share of crashes between 21:00 and 06:00 (local), with 95% interval, before and after the change</h4>
      <ul className="night-dots">
        {programs.map((p) => {
          const c = colorOf(PROGRAM_BY_KEY[p].color, mode);
          return (
            <li key={p}>
              <span className="nd-name">{PROGRAM_BY_KEY[p].short}</span>
              <span className="nd-track" aria-hidden="true">
                {[0, 25, 50, 75, 100].map((x) => <i key={x} className="nd-grid" style={{ left: `${x}%` }} />)}
                {(['pre', 'post'] as const).map((r) => {
                  const s = stats[p][r];
                  if (!s.night || s.n < MIN_N) return null;
                  const [v, lo, hi] = s.night;
                  return (
                    <span key={r} className={`nd-mark ${r}`} style={{ top: r === 'pre' ? '30%' : '70%' }}>
                      <i className="nd-ci" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, background: c }} />
                      <i className="nd-dot" style={{ left: `${v * 100}%`, borderColor: c, background: r === 'post' ? c : t.surface }} />
                    </span>
                  );
                })}
              </span>
              <span className="nd-val small">
                {(['pre', 'post'] as const).map((r) => {
                  const s = stats[p][r];
                  return <span key={r}>{r === 'pre' ? 'before' : 'after'}: {s.night && s.n >= MIN_N ? `${pctText(s.night[0])} [${pctText(s.night[1])}, ${pctText(s.night[2])}] of ${fmt(s.n)}` : `too few (${s.n})`}</span>;
                })}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="small">Hollow marker: before 2025-06-16; filled: after (June 2025 left out). Scale 0 to 100%.</p>
    </section>
  );
}

function HourPanel({ program, s, mode }: { program: string; s: HourStats; mode: Mode }) {
  const t = ui(mode);
  const color = colorOf(PROGRAM_BY_KEY[program].color, mode);
  const option = useMemo((): EChartsCoreOption => ({
    animation: false, textStyle: { color: t.muted },
    grid: { left: 34, right: 6, top: 8, bottom: 22 },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
      formatter: (ps: any) => {
        const h = ps[0].dataIndex as number;
        return `<b>${esc(PROGRAM_BY_KEY[program].short)}, ${String(h).padStart(2, '0')}:00-${String(h).padStart(2, '0')}:59</b><br>${fmt(s.hours[h])} crashes, ${pctText(s.hours[h] / s.n, 1)}`;
      },
    },
    xAxis: { type: 'category', data: s.hours.map((_, i) => String(i)), axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
      axisLabel: { color: t.muted, fontSize: 9.5, interval: 0, formatter: (v: string) => (Number(v) % 6 === 0 ? v.padStart(2, '0') : '') } },
    yAxis: { type: 'value', axisLabel: { color: t.muted, fontSize: 9.5, formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: t.grid } } },
    series: [{
      type: 'bar', barCategoryGap: '18%', data: s.hours.map((k, i) => ({ value: (k / s.n) * 100, itemStyle: { color, opacity: i >= 21 || i < 6 ? 1 : 0.55, borderRadius: [2, 2, 0, 0] } })),
    }],
  }), [s, program, color, t]);
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title"><i className="swatch" style={{ background: color }} /> {PROGRAM_BY_KEY[program].short}</span>
        <span className="panel-total"><span>{fmt(s.n)} crashes with a time · 21:00-06:00: <b>{pctText(s.night?.[0])}</b>{s.converted > 0 ? ' · times converted from UTC' : ''}</span></span>
      </figcaption>
      <EChart option={option} height={140} label={`${PROGRAM_BY_KEY[program].label}: share of crashes by local hour; night hours drawn darker`} />
    </figure>
  );
}
