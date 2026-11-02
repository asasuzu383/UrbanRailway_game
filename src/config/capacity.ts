/**
 * 輸送力制約（混雑率と混雑の不効用）のパラメータ（Phase 2 M5。docs/design.md §16）。
 */

export interface CapacityParams {
  /** ピーク 1 時間の断面輸送量 = 1 日の片方向の断面輸送量 × この比率 */
  readonly peakHourShare: number;
  /** 混雑の不効用: 新線の乗車時間の係数 = 1 + alpha × max(0, 混雑率 − threshold) */
  readonly crowding: { readonly threshold: number; readonly alpha: number };
  /** 警告する混雑率（target: 目標の水準、limit: 上限の水準） */
  readonly warn: { readonly target: number; readonly limit: number };
  /** 需要と混雑の均衡計算（係数を逐次平均法で更新） */
  readonly equilibrium: { readonly maxIterations: number; readonly tolerance: number };
}

export const defaultCapacityParams: CapacityParams = {
  // 仮置き: 首都圏の通勤路線では、最混雑区間のピーク 1 時間の片方向の輸送人員が 1 日の片方向の 15% 程度
  // （例: 田園都市線 池尻大橋→渋谷 7:50〜8:50 の 53,650 人［国交省 混雑率データ 令和6年度］と、1 日の断面輸送量の概数からの推定。要確認）
  peakHourShare: 0.15,
  // 仮置き: 定員（混雑率 100%）を超えた分に比例して乗車時間を重く感じる。150% で 1.25 倍、200% で 1.5 倍
  crowding: { threshold: 1.0, alpha: 0.5 },
  // 国土交通省の都市鉄道の混雑緩和の目標: 東京圏の主要区間のピーク時の平均混雑率 150%、個別路線 180% 以下
  warn: { target: 1.5, limit: 1.8 },
  equilibrium: { maxIterations: 6, tolerance: 0.01 },
};
