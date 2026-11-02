/**
 * 駅間所要時間の計算（運転曲線の簡易計算。docs/design.md §11.3）。
 * 前処理の scripts/06_services.py の run_seconds と同じ式（既存線の公表資料ベースの所要時間にも使っている）。
 */
import type { TransitTypeParams } from '../config/transitTypes';

/**
 * 駅間の走行時間 [秒]（停車時間を除く）。加速 → 最高速度 → 減速の台形、最高速度に届かなければ三角形。
 * @param distKm 駅間距離 [km]
 */
export function runSeconds(distKm: number, maxSpeedKmh: number, accelKmhPerS: number, decelKmhPerS: number): number {
  if (!(distKm > 0)) return 0;
  const d = distKm * 1000;
  const v = maxSpeedKmh / 3.6;
  const a = accelKmhPerS / 3.6;
  const b = decelKmhPerS / 3.6;
  const dAB = (v * v) / (2 * a) + (v * v) / (2 * b);
  if (d >= dAB) return v / a + v / b + (d - dAB) / v;
  const vp = Math.sqrt((2 * d * a * b) / (a + b));
  return vp / a + vp / b;
}

/** 停車駅間の所要時間 [分]（走行時間＋到着駅の停車時間、余裕係数込み） */
export function legMinutes(distKm: number, t: TransitTypeParams, arrivalIsTransfer: boolean): number {
  const dwell = arrivalIsTransfer ? t.dwellTransferSec : t.dwellSec;
  return ((runSeconds(distKm, t.maxSpeedKmh, t.accelKmhPerS, t.decelKmhPerS) + dwell) * t.runtimeMargin) / 60;
}
