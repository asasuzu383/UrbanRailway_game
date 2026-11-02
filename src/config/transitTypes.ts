/**
 * 交通機関タイプごとのパラメータ（Phase 2。docs/design.md §14）。
 * M3 では普通鉄道のみ。M4 でモノレール・新交通システム（AGT）・LRT を追加し、選べる構造・建設単価・輸送力なども持たせる。
 */

export type TransitTypeId = 'heavyRail';

export interface TransitTypeParams {
  readonly id: TransitTypeId;
  readonly name: string;
  /** 最高速度 [km/h] */
  readonly maxSpeedKmh: number;
  /** 起動加速度 [km/h/s] */
  readonly accelKmhPerS: number;
  /** 常用減速度 [km/h/s] */
  readonly decelKmhPerS: number;
  /** 標準停車時間 [秒] */
  readonly dwellSec: number;
  /** 乗換駅（接続駅）の停車時間 [秒] */
  readonly dwellTransferSec: number;
  /** 余裕時分・速度制限の係数（(走行時間 + 停車時間) × margin） */
  readonly runtimeMargin: number;
  /** 終端駅での折返し時間 [分] */
  readonly turnbackMin: number;
}

/**
 * 普通鉄道。値は既存線の公表資料ベースの所要時間計算（scripts/config/regions/<地域>/services.yaml の runtime）と揃える。
 * - 加速度 3.0 km/h/s: E233 系などの通勤電車の起動加速度（仮置き: 車両形式は特定しない）
 * - 減速度 3.5 km/h/s、停車 30 秒（接続駅 50 秒）: 仮置き
 * - 余裕係数 1.15: 都営地下鉄 4 線の時刻表（ODPT）との比較（docs/design.md §11.3）
 * - 最高速度 110 km/h: 仮置き（首都圏の通勤路線の多くが 100〜120 km/h）
 * - 折返し 10 分: 仮置き（Phase 1 の費用パラメータと同じ）
 */
export const TRANSIT_TYPES: Readonly<Record<TransitTypeId, TransitTypeParams>> = {
  heavyRail: {
    id: 'heavyRail',
    name: '普通鉄道',
    maxSpeedKmh: 110,
    accelKmhPerS: 3.0,
    decelKmhPerS: 3.5,
    dwellSec: 30,
    dwellTransferSec: 50,
    runtimeMargin: 1.15,
    turnbackMin: 10,
  },
};

export const DEFAULT_TRANSIT_TYPE: TransitTypeId = 'heavyRail';
