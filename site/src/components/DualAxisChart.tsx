import { FLAG_PATH } from './FlagNote';
import { useEffect, useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '../EChart';
import type { Grain, Point } from '../lib/metrics';
import { BREAK_DATE, INCOMPLETE_LABEL } from '../lib/metrics';
import { esc, fmtCI, fmtInt, fmtNum, fmtRateText, hatchPattern } from '../lib/format';
import type { EventRow } from '../data/rates';
import { ui, type Mode } from '../theme';

export type ChartSeries = { key: string; label: string; color: string; points: Point[] };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

type Axis = { min: number; max: number; ticks: number[]; label: (v: number) => string; xOf: (period: string) => number; xOfDate: (d: string) => number | null };

function makeAxis(grain: Grain, firstYear: number, lastYear: number, year: number): Axis {
  if (grain === 'year') {
    const ticks = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
    return {
      min: firstYear - 0.5, max: lastYear + 0.5, ticks, label: (v) => String(Math.round(v)),
      xOf: (p) => Number(p),
      xOfDate: (d) => {
        const y = Number(d.slice(0, 4));
        const dt = Date.UTC(y, Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
        const frac = (dt - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
        const x = y - 0.5 + frac;
        return x < firstYear - 0.5 || x > lastYear + 0.5 ? null : x;
      },
    };
  }
  return {
    min: -0.5, max: 11.5, ticks: Array.from({ length: 12 }, (_, i) => i), label: (v) => MONTHS[Math.round(v)] ?? '',
    xOf: (p) => Number(p.slice(5, 7)) - 1,
    xOfDate: (d) => {
      if (Number(d.slice(0, 4)) !== year) return null;
      const m = Number(d.slice(5, 7));
      return m - 1 - 0.5 + (Number(d.slice(8, 10)) - 1) / daysIn(year, m);
    },
  };
}

export function DualAxisChart({
  series,
  grain,
  firstYear,
  lastYear,
  year,
  metricAxis,
  volumeUnit,
  volumeNote,
  events,
  mode,
  ariaLabel,
  height = 420,
}: {
  series: ChartSeries[];
  grain: Grain;
  firstYear: number;
  lastYear: number;
  year: number;
  metricAxis: string;
  volumeUnit: 'miles' | 'vehicles';
  /** Replaces the right-axis name, e.g. when the exposure is informational only. */
  volumeNote?: string;
  events: EventRow[] | null;
  mode: Mode;
  ariaLabel: string;
  height?: number;
}) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 600);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 600);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const option = useMemo<EChartsCoreOption>(() => {
    const t = ui(mode);
    const axis = makeAxis(grain, firstYear, lastYear, year);
    const periodLabel = (p: string) => p;
    const breakX = axis.xOfDate(BREAK_DATE);
    const periods = series[0]?.points.map((p) => p.period) ?? [];

    const eventLines = (events ?? [])
      .map((ev) => ({ x: axis.xOfDate(ev.date), e: ev }))
      .filter((v): v is { x: number; e: EventRow } => v.x != null && v.e.date !== BREAK_DATE);

    const all: unknown[] = [];

    for (const s of series) {
      const hatch = hatchPattern(s.color);
      const vol = s.points.filter((p) => p.volume != null && p.volumeUnit === volumeUnit);
      // Right axis: exposure volume (a bar-area behind everything).
      all.push({
        id: `vol:${s.key}`, name: `${s.label} exposure`, type: 'custom', yAxisIndex: 1, z: 1, silent: true,
        tooltip: { show: false },
        data: vol.map((p) => [axis.xOf(p.period), p.volume!]),
        renderItem: (_: unknown, api: any) => {
          const x = api.value(0);
          const [x0, y] = api.coord([x - 0.46, api.value(1)]);
          const [x1, y0] = api.coord([x + 0.46, 0]);
          return { type: 'rect', shape: { x: x0, y, width: x1 - x0, height: y0 - y }, style: { fill: s.color, opacity: 0.13 } };
        },
      });
      // Left axis: 95% interval, hatched where the sample is small or the exposure is an estimate.
      const ci = s.points.filter((p) => p.rate != null && p.lo != null && p.hi != null);
      all.push({
        id: `ci:${s.key}`, name: `${s.label} 95% interval`, type: 'custom', yAxisIndex: 0, z: 2, silent: true,
        tooltip: { show: false },
        data: ci.map((p) => [axis.xOf(p.period), p.lo!, p.hi!, p.lowSample ? 1 : 0]),
        renderItem: (_: unknown, api: any) => {
          const x = api.value(0);
          const low = api.value(3) === 1;
          const [x0, yHi] = api.coord([x - 0.4, api.value(2)]);
          const [x1, yLo] = api.coord([x + 0.4, api.value(1)]);
          return {
            type: 'rect',
            shape: { x: x0, y: yHi, width: x1 - x0, height: Math.max(2, yLo - yHi) },
            style: low
              ? { fill: hatch, stroke: s.color, lineWidth: 1, lineDash: [3, 2] }
              : { fill: s.color, opacity: 0.22, stroke: s.color, lineWidth: 0.5 },
          };
        },
      });
      // Recent months whose reports are still arriving are drawn dotted with hollow markers: the line from the last
      // complete point to them is dotted, never solid.
      const late = (p: Point) => p.incomplete.length > 0;
      const solid = s.points.map((p) => (late(p) ? null : p));
      // The line is never joined across the 2025-06-16 rule change: a period that contains it (2025, or June 2025) stands
      // alone as a marker, and a gap is inserted on both sides of it.
      const straddles = (period: string) => (grain === 'year' ? period === BREAK_DATE.slice(0, 4) : period === BREAK_DATE.slice(0, 7));
      const crosses = (a: string, b: string) => a < BREAK_DATE.slice(0, a.length) && b > BREAK_DATE.slice(0, b.length);
      const lineData: unknown[] = [];
      solid.forEach((p, i) => {
        const period = s.points[i].period;
        if (i > 0) {
          const prev = s.points[i - 1].period;
          if (straddles(prev) || straddles(period) || crosses(prev, period)) lineData.push({ value: [(axis.xOf(prev) + axis.xOf(period)) / 2, null] });
        }
        lineData.push({
          value: [axis.xOf(period), p ? p.rate : null],
          // hollow marker = low sample / estimate
          itemStyle: p?.lowSample ? { color: t.surface, borderColor: s.color, borderWidth: 2 } : { color: s.color, borderColor: t.surface, borderWidth: 1.5 },
        });
      });
      all.push({
        id: `rate:${s.key}`, name: s.label, type: 'line', yAxisIndex: 0, z: 4, silent: true,
        tooltip: { show: false },
        connectNulls: false, symbol: 'circle', symbolSize: 9,
        lineStyle: { color: s.color, width: 2 }, itemStyle: { color: s.color },
        data: lineData,
      });
      const firstLate = s.points.findIndex(late);
      if (firstLate >= 0) {
        const from = Math.max(0, firstLate - 1);
        const tail = s.points.slice(from).filter((p) => p.rate != null);
        all.push({
          id: `late:${s.key}`, name: `${s.label} recent months`, type: 'line', yAxisIndex: 0, z: 4, silent: true, tooltip: { show: false },
          symbol: 'circle', symbolSize: 9, lineStyle: { color: s.color, width: 2, type: [2, 3] },
          data: tail.map((p) => ({
            value: [axis.xOf(p.period), p.rate],
            itemStyle: late(p)
              ? { color: t.surface, borderColor: s.color, borderWidth: 2, borderType: 'dotted' }
              : { color: s.color, borderColor: t.surface, borderWidth: 1.5 },
          })),
        });
      }
      // Invisible series so the left axis scale includes the upper interval limits.
      all.push({
        id: `scale:${s.key}`, name: `${s.label} scale`, type: 'line', yAxisIndex: 0, silent: true, tooltip: { show: false },
        showSymbol: false, symbol: 'none', lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
        data: s.points.map((p) => [axis.xOf(p.period), p.hi ?? p.lo ?? p.rate]).filter((d) => d[1] != null),
      });
      // Periods with no usable denominator are marked "no data" on the baseline, never drawn as zero.
      const nd = s.points.filter((p) => p.rate == null && !p.lowerBound && !/began 2021-07/.test(p.reason ?? ''));
      if (nd.length) {
        all.push({
          id: `nd:${s.key}`, name: `${s.label} no data`, type: 'scatter', yAxisIndex: 0, z: 5, silent: true, tooltip: { show: false },
          symbol: 'circle', symbolSize: 5, itemStyle: { color: t.faint },
          label: { show: true, formatter: 'no data', position: 'top', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 6, color: t.faint, fontSize: 10 },
          data: nd.map((p) => [axis.xOf(p.period), 0]),
        });
      }
      // Months whose exposure the pipeline flags as unreliable (>3x adjacent segments): a flag above the point.
      const fl = s.points.filter((p) => p.flag);
      if (fl.length) {
        all.push({
          id: `flag:${s.key}`, name: `${s.label} unreliable exposure`, type: 'scatter', yAxisIndex: 0, z: 6, silent: true, tooltip: { show: false },
          symbol: FLAG_PATH, symbolSize: [11, 14], symbolOffset: [5, -16],
          itemStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', borderColor: t.surface, borderWidth: 0.5 },
          data: fl.map((p) => [axis.xOf(p.period), p.hi ?? p.rate ?? 0]),
        });
      }
      const lb = s.points.filter((p) => p.lowerBound && p.lo != null);
      if (lb.length) {
        all.push({
          id: `lb:${s.key}`, name: `${s.label} lower bound`, type: 'scatter', yAxisIndex: 0, z: 5, silent: true,
          tooltip: { show: false },
          symbol: 'path://M0,-6L6,5L-6,5Z', symbolSize: 11,
          itemStyle: { color: t.surface, borderColor: s.color, borderWidth: 2 },
          data: lb.map((p) => [axis.xOf(p.period), p.lo!]),
        });
      }
    }

    // Hatched columns behind periods that include months whose reports are still arriving.
    const lateX = [...new Set(series.flatMap((sr) => sr.points.filter((p) => p.incomplete.length > 0).map((p) => p.period)))];
    if (lateX.length) {
      const hatchGrey = hatchPattern(t.faint);
      all.push({
        id: 'incomplete', name: INCOMPLETE_LABEL, type: 'custom', yAxisIndex: 0, z: 0, silent: true, tooltip: { show: false },
        data: lateX.map((p) => [axis.xOf(p)]),
        renderItem: (params: any, api: any) => {
          const x = api.value(0);
          const [x0] = api.coord([x - 0.5, 0]);
          const [x1] = api.coord([x + 0.5, 0]);
          const cs = params.coordSys;
          return { type: 'rect', shape: { x: x0, y: cs.y, width: x1 - x0, height: cs.height }, style: { fill: hatchGrey, opacity: 0.22 } };
        },
      });
    }

    // Transparent hit areas: one per period, tooltip lists every selected program for that period.
    all.push({
      id: 'hit', name: 'periods', type: 'custom', yAxisIndex: 0, z: 10,
      data: periods.map((p) => [axis.xOf(p)]),
      renderItem: (params: any, api: any) => {
        const x = api.value(0);
        const [x0] = api.coord([x - 0.5, 0]);
        const [x1] = api.coord([x + 0.5, 0]);
        const cs = params.coordSys;
        return { type: 'rect', shape: { x: x0, y: cs.y, width: x1 - x0, height: cs.height }, style: { fill: 'rgba(128,128,128,0.001)' }, emphasis: { style: { fill: 'rgba(128,128,128,0.10)' } } };
      },
      tooltip: {
        trigger: 'item', confine: true,
        formatter: (p: any) => {
          const i = p.dataIndex as number;
          const head = `<div style="font-weight:600;margin-bottom:3px">${esc(periodLabel(periods[i]))}</div>`;
          const rows = series.map((s) => {
            const pt = s.points[i];
            if (!pt) return '';
            const tags: string[] = [];
            if (pt.lowSample && pt.rate != null) tags.push('low sample / estimate (hatched)');
            if (pt.scenario) tags.push(pt.assumption ? 'your assumption (not a disclosure)' : 'scenario');
            if (pt.partial && pt.volume != null) tags.push('partial period');
            if (pt.incomplete.length) tags.push(INCOMPLETE_LABEL + ': ' + pt.incomplete.join(', '));
            if (pt.flag) tags.push('\u2691 unreliable monthly exposure: ' + pt.flag);
            const body =
              pt.rate == null && !pt.lowerBound
                ? `<span>no data: ${esc(pt.reason ?? 'no denominator')}</span>`
                : `<span>${esc(fmtRateText(pt))} (95% CI ${esc(fmtCI(pt))})</span>`;
            return (
              `<div style="margin-top:4px"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${s.color};margin-right:5px"></span><b>${esc(s.label)}</b><br>` +
              `${body}<br><span>${esc(fmtInt(pt.k))} crashes counted${pt.kAdj !== pt.k ? ` (${esc(fmtNum(pt.kAdj))} adjusted)` : ''}; ` +
              `${pt.exposure != null ? `${esc(fmtNum(pt.exposure))} ${pt.exposureUnit} (${esc(pt.exposureKind ?? '')})` : pt.volume != null ? `${esc(fmtNum(pt.volume))} ${pt.volumeUnit} shown, not used as denominator` : 'no exposure'}</span>` +
              `${tags.length ? `<br><i>${esc(tags.join('; '))}</i>` : ''}</div>`
            );
          });
          return `<div style="max-width:300px;white-space:normal;font-size:12.5px">${head}${rows.join('')}</div>`;
        },
      },
    });

    // Break line + events, on a host series.
    const lines: unknown[] = [];
    if (breakX != null) {
      lines.push({
        xAxis: breakX, name: 'break',
        lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 2 },
        label: { show: true, formatter: 'SGO rules change 2025-06-16', position: 'insideEndTop', color: t.muted, fontSize: 11, rotate: 90 },
      });
    }
    for (const { x, e } of eventLines) {
      lines.push({
        xAxis: x, name: e.label, eventDate: e.date,
        lineStyle: { color: t.faint, type: [1, 4], width: 1, opacity: 0.55 },
        label: { show: false },
      });
    }
    all.push({
      id: 'marks', name: 'marks', type: 'line', data: [], z: 3,
      markLine: {
        symbol: 'none', silent: false, animation: false,
        tooltip: {
          confine: true,
          formatter: (p: any) =>
            p.data?.name === 'break'
              ? '<div style="max-width:280px;white-space:normal;font-size:12.5px"><b>2025-06-16: Third Amended SGO takes effect.</b><br>Reporting thresholds and the data schema changed. A drop after this line is not evidence of safer driving.</div>'
              : `<div style="max-width:280px;white-space:normal;font-size:12.5px"><b>${esc(p.data?.eventDate)}</b><br>${esc(p.data?.name)}</div>`,
        },
        data: lines,
      },
    });

    return {
      animation: false,
      textStyle: { color: t.muted },
      grid: narrow ? { left: 46, right: 46, top: 40, bottom: 28 } : { left: 64, right: 64, top: 34, bottom: 30 },
      tooltip: { backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink }, extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,.2)' },
      xAxis: {
        type: 'value', min: axis.min, max: axis.max, interval: 1,
        axisLabel: { color: t.muted, customValues: axis.ticks, formatter: (v: number) => (narrow && grain === 'month' ? axis.label(v).slice(0, 1) : axis.label(v)) },
        axisTick: { customValues: axis.ticks, lineStyle: { color: t.rule } },
        axisLine: { lineStyle: { color: t.rule } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value', min: 0, name: narrow ? '' : metricAxis, nameLocation: 'end', nameTextStyle: { color: t.muted, align: 'left', fontSize: 11 },
          axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) }, splitLine: { lineStyle: { color: t.grid } },
        },
        {
          type: 'value', min: 0, position: 'right', name: narrow ? '' : volumeNote ?? (volumeUnit === 'miles' ? 'exposure: miles' : 'exposure: active vehicles'),
          nameTextStyle: { color: t.muted, align: 'right', fontSize: 11 },
          axisLabel: { color: t.muted, formatter: (v: number) => fmtNum(v) }, splitLine: { show: false },
        },
      ],
      series: all,
    } as EChartsCoreOption;
  }, [series, grain, firstYear, lastYear, year, metricAxis, volumeUnit, volumeNote, events, mode, narrow]);

  return <EChart option={option} height={narrow ? 340 : height} label={ariaLabel} />;
}
