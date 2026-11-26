import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  BarChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export function EChart({ option, height, label }: { option: EChartsCoreOption; height: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = host.current!;
    const c = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);

  return <div ref={host} role="img" aria-label={label} style={{ height, width: '100%' }} />;
}

export function SourceNote({ date, extra }: { date: string; extra?: string }) {
  return (
    <p className="source-note">
      NHTSA SGO 2021-01, fetched {date}.{extra ? ' ' + extra : ''}
    </p>
  );
}
