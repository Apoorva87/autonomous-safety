import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '../EChart';
import type { CompanyRow } from '../data/rates';
import { esc, fmtNum } from '../lib/format';
import { SourceBadge } from './SourceBadge';
import { ui, type Mode } from '../theme';

const R12 = [
  ['fsd_r12m_miles', 'FSD miles (R12M)'],
  ['fsd_r12m_major_collisions', 'FSD major collisions'],
  ['fsd_r12m_minor_collisions', 'FSD minor collisions'],
  ['fsd_r12m_miles_per_major_collision', 'FSD miles per major collision'],
  ['fsd_r12m_miles_per_minor_collision', 'FSD miles per minor collision'],
  ['manual_active_safety_r12m_miles_per_major_collision', 'Manual + active safety, miles per major collision'],
  ['manual_no_active_safety_r12m_miles_per_major_collision', 'Manual, no active safety, miles per major collision'],
  ['us_average_miles_per_major_collision_cited', 'US average cited by Tesla, miles per major collision'],
] as const;

/** Tesla's own Vehicle Safety Report. Separate from every NHTSA SGO series: different window, different crash definition. */
export function TeslaVsrPanel({ rows, mode }: { rows: CompanyRow[]; mode: Mode }) {
  const vsr = useMemo(() => rows.filter((r) => r.program === 'tesla_l2' && r.metric.startsWith('vsr_')), [rows]);
  const r12 = useMemo(() => rows.filter((r) => r.program === 'tesla_l2' && /^(fsd|manual)_.*r12m|^us_average/.test(r.metric)), [rows]);
  const quarters = useMemo(() => [...new Set(vsr.map((r) => r.period))].sort(), [vsr]);
  const sourceIds = useMemo(() => [...new Set([...vsr, ...r12].flatMap((r) => r.source_ids))], [vsr, r12]);

  const option = useMemo<EChartsCoreOption>(() => {
    const t = ui(mode);
    const line = (metric: string, name: string, color: string, dashed = false) => ({
      name, type: 'line', symbol: 'circle', symbolSize: 6, lineStyle: { color, width: 2, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color },
      data: quarters.map((q) => vsr.find((r) => r.metric === metric && r.period === q)?.value ?? null),
    });
    return {
      animation: false, textStyle: { color: t.muted },
      grid: { left: 64, right: 20, top: 34, bottom: 56 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        valueFormatter: (v: unknown) => (v == null ? 'no data' : fmtNum(Number(v)) + ' miles per crash'),
        formatter: (ps: any) => `<b>${esc(ps[0]?.axisValue)}</b><br>` + ps.map((p: any) => `${esc(p.seriesName)}: ${p.value == null ? 'no data' : esc(fmtNum(Number(p.value)))}`).join('<br>'),
      },
      legend: { bottom: 0, textStyle: { color: t.muted }, itemWidth: 14 },
      xAxis: { type: 'category', data: quarters, axisLabel: { color: t.muted, interval: 3 }, axisLine: { lineStyle: { color: t.rule } } },
      yAxis: { type: 'value', min: 0, name: 'miles per crash', nameTextStyle: { color: t.muted, align: 'left', fontSize: 11 }, axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        line('vsr_miles_per_crash_autopilot', 'Autopilot engaged (Tesla, 5 s)', mode === 'dark' ? '#3987e5' : '#2a78d6'),
        line('vsr_miles_per_crash_no_autopilot', 'No Autopilot (Tesla)', t.muted, true),
        line('vsr_us_baseline_miles_per_crash_cited', 'US average cited by Tesla', t.faint, true),
      ],
    } as EChartsCoreOption;
  }, [quarters, vsr, mode]);

  const periods = [...new Set(r12.map((r) => r.period))].sort();
  return (
    <section className="vsr-panel" aria-labelledby="vsr-h">
      <h3 id="vsr-h">
        Tesla's own Vehicle Safety Report (company-reported) <SourceBadge sourceIds={sourceIds} label="Tesla report sources" />
      </h3>
      <p className="prose small">
        <b>Tesla counts crashes within 5 seconds of disengagement; NHTSA SGO uses 30 seconds.</b> Tesla's figures are worldwide, include crashes that are
        not reportable to NHTSA, and use airbag or active-restraint deployment as the crash definition. They are shown on their own and are never merged with,
        or drawn on the same axis as, any NHTSA series.
      </p>
      <EChart option={option} height={320} label="Tesla Vehicle Safety Report: miles per crash by quarter with Autopilot, without Autopilot, and the US average Tesla cites" />
      {periods.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="small" style={{ textAlign: 'left', padding: '6px 10px' }}>Rolling 12-month figures published by Tesla (North America)</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                {periods.map((p) => <th scope="col" key={p} className="num">{p}</th>)}
              </tr>
            </thead>
            <tbody>
              {R12.map(([metric, label]) => (
                <tr key={metric}>
                  <th scope="row">{label}</th>
                  {periods.map((p) => {
                    const v = r12.find((r) => r.metric === metric && r.period === p);
                    return <td key={p} className="num">{v ? fmtNum(v.value) : 'no data'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
