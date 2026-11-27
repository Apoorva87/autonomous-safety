import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, HeatmapChart, LineChart, SankeyChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  AriaComponent,
  BarChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  SankeyChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

type Handlers = Record<string, (params: any) => void>;

export function EChart({ option, height, label, onEvents }: { option: EChartsCoreOption; height: number; label: string; onEvents?: Handlers }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const handlers = useRef<Handlers | undefined>(onEvents);
  handlers.current = onEvents;

  useEffect(() => {
    const el = host.current!;
    const c = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.current = c;
    // Click events go to the latest handlers, so callers can pass inline functions.
    c.on('click', (p: unknown) => handlers.current?.click?.(p));
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
