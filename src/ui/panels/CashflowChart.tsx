import {
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type Plugin,
} from 'chart.js';
import { useEffect, useRef } from 'preact/hooks';
import type { FinanceResult } from '../../core/types';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

// 系列色（カテゴリカル 1・2 番目）と軸・文字色。文字は系列色ではなく文字色で描く
const COLORS = { cum: '#2a78d6', disc: '#eb6834', grid: '#e6e5e1', zero: '#52514e', text: '#52514e' };

interface Marker {
  readonly year: number;
  readonly label: string;
  readonly color: string;
}

/** 回収時点に縦の破線とラベルを描くプラグイン（markers は描画のたびに getMarkers() から読む） */
function paybackMarkers(getMarkers: () => readonly Marker[]): Plugin<'line'> {
  return {
    id: 'paybackMarkers',
    afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const x = scales.x!;
    ctx.save();
    getMarkers().forEach((m, i) => {
      const px = x.getPixelForValue(m.year);
      if (px < chartArea.left || px > chartArea.right) return;
      ctx.strokeStyle = m.color;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = px > (chartArea.left + chartArea.right) / 2 ? 'right' : 'left';
      ctx.fillText(m.label, px + (ctx.textAlign === 'left' ? 4 : -4), chartArea.top + 12 + i * 14);
    });
    ctx.restore();
    },
  };
}

/** 横軸の年数: 回収年数の少し先まで（最短 30 年、最長 60 年） */
function horizon(f: FinanceResult): number {
  const target = f.discountedPaybackYears ?? f.simplePaybackYears;
  return Math.min(60, Math.max(30, target === null ? 50 : Math.ceil(target) + 10));
}

export function CashflowChart({ finance, discountRate }: { finance: FinanceResult; discountRate: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart<'line', number[], number> | null>(null);
  const markers = useRef<Marker[]>([]);

  useEffect(() => {
    if (!canvas.current) return;
    chart.current = new Chart(canvas.current, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '開業後の年数', color: COLORS.text },
            ticks: { color: COLORS.text, stepSize: 10 },
            grid: { color: COLORS.grid },
          },
          y: {
            // 損益分岐（0）が常に見えるように 0 を含める
            suggestedMax: 0,
            suggestedMin: 0,
            title: { display: true, text: '億円', color: COLORS.text },
            ticks: { color: COLORS.text, callback: (v) => Number(v).toLocaleString('ja-JP') },
            grid: { color: (c) => (c.tick.value === 0 ? COLORS.zero : COLORS.grid), lineWidth: (c) => (c.tick.value === 0 ? 1.5 : 1) },
          },
        },
        plugins: {
          legend: { position: 'top', align: 'start', labels: { boxWidth: 14, boxHeight: 2, color: COLORS.text } },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0]?.parsed.x ?? ''} 年目`,
              label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y ?? 0).toLocaleString('ja-JP')} 億円`,
            },
          },
        },
      },
      plugins: [paybackMarkers(() => markers.current)],
    });
    return () => chart.current?.destroy();
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const n = horizon(finance);
    const rows = finance.timeline.slice(0, n + 1);
    const pts = (key: 'cumulativeCashFlow' | 'cumulativeDiscountedCashFlow') => rows.map((r) => ({ x: r.year, y: r[key] / 1e8 }));
    c.data.datasets = [
      { label: '累積キャッシュフロー', data: pts('cumulativeCashFlow') as unknown as number[], borderColor: COLORS.cum, backgroundColor: COLORS.cum, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
      { label: `割引後（年 ${(discountRate * 100).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%）`, data: pts('cumulativeDiscountedCashFlow') as unknown as number[], borderColor: COLORS.disc, backgroundColor: COLORS.disc, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
    ];
    const m: Marker[] = [];
    if (finance.simplePaybackYears !== null) m.push({ year: finance.simplePaybackYears, label: `単純回収 ${finance.simplePaybackYears.toFixed(1)}年`, color: COLORS.cum });
    if (finance.discountedPaybackYears !== null) m.push({ year: finance.discountedPaybackYears, label: `割引回収 ${finance.discountedPaybackYears.toFixed(1)}年`, color: COLORS.disc });
    markers.current = m;
    c.options.scales!.x!.max = n;
    c.options.scales!.x!.min = 0;
    c.update();
  }, [finance, discountRate]);

  return (
    <div class="chart-box">
      <canvas ref={canvas} role="img" aria-label="累積キャッシュフローのグラフ（開業時点に建設費を計上し、毎年の営業収支を積み上げたもの）" />
    </div>
  );
}
