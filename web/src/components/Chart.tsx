import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useCssVars } from '../lib/hooks';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, DataZoomComponent, CanvasRenderer]);

export type EChartsOption = echarts.EChartsCoreOption;

const VARS = [
  'text-primary', 'text-secondary', 'text-muted', 'surface-1', 'surface-2', 'border', 'grid-line', 'axis-line', 'band', 'accent',
  'fuel-nuclear', 'fuel-coal', 'fuel-hydro', 'fuel-gas', 'fuel-wind', 'fuel-solar', 'fuel-storage', 'fuel-other',
  'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'status-warning', 'status-critical', 'status-good',
] as const;
export type ChartColors = Record<(typeof VARS)[number], string>;

export function useChartColors(): ChartColors {
  return useCssVars(VARS);
}

/** Shared chart chrome: recessive grid, muted axes, crosshair tooltip, legend on top. */
export function baseOption(c: ChartColors, opts: { yName?: string; yFormatter?: (v: number) => string } = {}): EChartsOption {
  return {
    animation: false,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: c['text-secondary'] },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: c['text-secondary'] } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: c['axis-line'] } },
      backgroundColor: c['surface-1'],
      borderColor: c.border,
      textStyle: { color: c['text-primary'], fontSize: 12 },
      valueFormatter: opts.yFormatter as never,
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: c['axis-line'] } },
      axisTick: { show: false },
      axisLabel: {
        color: c['text-muted'],
        hideOverlap: true,
        formatter: (v: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false, month: 'short', day: 'numeric' }).format(v),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: opts.yName,
      nameTextStyle: { color: c['text-muted'], align: 'left' },
      scale: true,
      axisLabel: { color: c['text-muted'], formatter: opts.yFormatter },
      splitLine: { lineStyle: { color: c['grid-line'] } },
    },
  };
}

export function Chart({ option, height = 280, ariaLabel }: { option: EChartsOption; height?: number; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>();

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.current?.dispose(); };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ width: '100%', height }} />;
}
