import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '../EChart';
import { poissonQuantile } from '../lib/poisson';
import { esc, fmtInt, fmtNum } from '../lib/format';
import { ui, type Mode } from '../theme';
import { singleKindItems, type KindId } from '../lib/kinds';

export type FunnelPoint = {
  program: string; label: string; color: string; period: string;
  rate: number; exposure: number; k: number; lowSample: boolean; scenario: boolean;
  /** Kind group: the pooled reference never spans two kinds. */
  kind: KindId | null;
  /** The year includes months whose reports are still arriving. */
  incomplete?: boolean;
};

/** Pooled-rate funnel with exact Poisson control limits: the standard way to compare units whose volumes differ widely. */
export function FunnelPlot({
  points: allPoints, factor, rateLabel, exposureLabel, mode, refProgram,
}: { points: FunnelPoint[]; factor: number; rateLabel: string; exposureLabel: string; mode: Mode; refProgram?: string }) {
  // Level 2 and ADS programs have different reporting thresholds: a pooled rate and its limits only ever span one kind.
  const points = useMemo(() => singleKindItems(allPoints), [allPoints]);
  const model = useMemo(() => {
    const refPts = refProgram && points.some((p) => p.program === refProgram) ? points.filter((p) => p.program === refProgram) : points;
    const sumK = refPts.reduce((a, p) => a + (p.rate * p.exposure) / factor, 0);
    const sumE = refPts.reduce((a, p) => a + p.exposure, 0);
    const pooled = sumE > 0 ? sumK / sumE : 0; // events per unit of exposure
    const xs = points.map((p) => p.exposure);
    const lo = Math.min(...xs) / 1.6;
    const hi = Math.max(...xs) * 1.6;
    const grid: number[] = [];
    for (let i = 0; i <= 60; i++) grid.push(lo * Math.pow(hi / lo, i / 60));
    const lim = (p: number) => grid.map((x) => [x, (poissonQuantile(p, pooled * x) / x) * factor]);
    return {
      pooled, lo, hi,
      l95: lim(0.025), u95: lim(0.975), l998: lim(0.001), u998: lim(0.999),
    };
  }, [points, factor, refProgram]);

  const option = useMemo<EChartsCoreOption>(() => {
    const t = ui(mode);
    const byProgram = new Map<string, FunnelPoint[]>();
    for (const p of points) byProgram.set(p.program, [...(byProgram.get(p.program) ?? []), p]);
    const limit = (name: string, data: number[][], dashed: boolean) => ({
      name, type: 'line', data, symbol: 'none', silent: true, tooltip: { show: false },
      lineStyle: { color: t.muted, width: dashed ? 1.2 : 1.6, type: dashed ? 'dashed' : 'solid' },
    });
    const upper = (p: FunnelPoint) => (poissonQuantile(0.999, model.pooled * p.exposure) / p.exposure) * factor;
    const upper95 = (p: FunnelPoint) => (poissonQuantile(0.975, model.pooled * p.exposure) / p.exposure) * factor;
    const lower95 = (p: FunnelPoint) => (poissonQuantile(0.025, model.pooled * p.exposure) / p.exposure) * factor;
    return {
      animation: false,
      textStyle: { color: t.muted },
      grid: { left: 62, right: 24, top: 34, bottom: 44 },
      tooltip: {
        trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (q: any) => {
          const p = q.data?.p as FunnelPoint | undefined;
          if (!p) return '';
          const where = p.rate > upper(p) ? 'above the 99.8% limit' : p.rate > upper95(p) ? 'above the 95% limit' : p.rate < lower95(p) ? 'below the 95% limit' : 'within the 95% limits';
          return `<div style="max-width:260px;white-space:normal;font-size:12.5px"><b>${esc(p.label)} ${esc(p.period)}</b><br>${esc(fmtNum(p.rate))} ${esc(rateLabel)}<br>${esc(fmtInt(p.k))} crashes over ${esc(fmtNum(p.exposure))} ${esc(exposureLabel)}<br><i>${where}${p.lowSample ? '; low sample / estimate' : ''}${p.scenario ? '; scenario' : ''}${p.incomplete ? '; includes recent months with late reports expected' : ''}</i></div>`;
        },
      },
      xAxis: {
        type: 'log', min: model.lo, max: model.hi, name: `exposure (${exposureLabel}), log scale`, nameLocation: 'middle', nameGap: 26,
        nameTextStyle: { color: t.muted, fontSize: 11 },
        axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) }, axisLine: { lineStyle: { color: t.rule } }, splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, name: rateLabel, nameTextStyle: { color: t.muted, align: 'left', fontSize: 11 },
        axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) }, splitLine: { lineStyle: { color: t.grid } },
      },
      series: [
        limit('lower 99.8%', model.l998, true), limit('upper 99.8%', model.u998, true),
        limit('lower 95%', model.l95, false), limit('upper 95%', model.u95, false),
        {
          name: 'pooled rate', type: 'line', symbol: 'none', silent: true, tooltip: { show: false },
          data: [[model.lo, model.pooled * factor], [model.hi, model.pooled * factor]],
          lineStyle: { color: t.ink, width: 1.2, opacity: 0.7 },
        },
        ...[...byProgram.entries()].map(([prog, ps]) => ({
          name: ps[0].label, id: prog, type: 'scatter', symbolSize: 11, z: 5,
          data: ps.map((p) => ({
            value: [p.exposure, p.rate], p,
            itemStyle: p.lowSample ? { color: t.surface, borderColor: ps[0].color, borderWidth: 2 } : { color: ps[0].color, borderColor: t.surface, borderWidth: 1.5 },
            label: { show: points.length <= 30, formatter: p.period.slice(-2), position: 'right', color: t.muted, fontSize: 10 },
          })),
        })),
      ],
    } as EChartsCoreOption;
  }, [points, model, factor, rateLabel, exposureLabel, mode]);

  return (
    <EChart
      option={option}
      height={380}
      label={`Funnel plot of ${rateLabel} against exposure with 95% and 99.8% control limits around the pooled rate ${fmtNum(model.pooled * factor)}`}
    />
  );
}
