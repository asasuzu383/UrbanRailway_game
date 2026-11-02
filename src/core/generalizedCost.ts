/**
 * 一般化費用（docs/design.md §13）。Phase 2 の経路転換、Phase 3 の経路選択、Phase 4 の便益計算で共通に使う。
 * 前処理側の scripts/gencost.py と同じ式。
 *
 *   一般化費用 [分] = 乗車時間 + w_wait × 待ち時間 + 乗換抵抗 + w_access × アクセス時間 + w_walk × 徒歩乗換時間
 *   待ち時間 = min(60 / 代表本数 / 2, 上限)、代表本数 = ピーク × peakShare + 日中 × (1 − peakShare)
 *   直通運転は乗換なし（乗換抵抗・待ち時間とも 0）
 */

/** 一般化費用の重み（値は src/config/regions/<地域>/demand.calibrated.json の generalizedCost） */
export interface GeneralizedCostWeights {
  /** 待ち時間の重み（乗車時間 1 に対して） */
  readonly waitWeight: number;
  /** 待ち時間の上限 [分] */
  readonly maxWaitMin: number;
  /** 代表本数のピーク本数の重み */
  readonly peakShare: number;
  /** 駅間の徒歩乗換の重み */
  readonly walkWeight: number;
  /** 駅までのアクセス（徒歩）の重み。省略時は walkWeight */
  readonly accessWeight?: number;
}

/** 一般化費用の内訳 [分]（重みを掛ける前の時間。乗換抵抗は分換算の抵抗の合計） */
export interface CostComponents {
  readonly inVehicleMin: number;
  readonly waitMin: number;
  readonly transferMin: number;
  readonly accessMin: number;
  readonly walkMin: number;
}

export const ZERO_COST: CostComponents = { inVehicleMin: 0, waitMin: 0, transferMin: 0, accessMin: 0, walkMin: 0 };

/** 時間帯別の本数 [本/時]（片方向） */
export interface Frequency {
  readonly peak: number;
  readonly offpeak: number;
}

export function representativeTph(f: Frequency, w: GeneralizedCostWeights): number {
  return f.peak * w.peakShare + f.offpeak * (1 - w.peakShare);
}

/** 待ち時間 [分] = min(運行間隔 / 2, 上限)。本数 0 なら上限 */
export function waitMinutes(tph: number, w: GeneralizedCostWeights): number {
  if (!(tph > 0)) return w.maxWaitMin;
  return Math.min(60 / tph / 2, w.maxWaitMin);
}

/** 内訳から一般化費用 [分] */
export function generalizedMinutes(c: CostComponents, w: GeneralizedCostWeights): number {
  return c.inVehicleMin + w.waitWeight * c.waitMin + c.transferMin + (w.accessWeight ?? w.walkWeight) * c.accessMin + w.walkWeight * c.walkMin;
}

export function addCosts(a: CostComponents, b: CostComponents): CostComponents {
  return {
    inVehicleMin: a.inVehicleMin + b.inVehicleMin,
    waitMin: a.waitMin + b.waitMin,
    transferMin: a.transferMin + b.transferMin,
    accessMin: a.accessMin + b.accessMin,
    walkMin: a.walkMin + b.walkMin,
  };
}

/**
 * 1 回の乗車（乗換を含む）の内訳。throughRunning なら直通運転として乗換抵抗・待ち時間を 0 にする。
 * @param transfer 乗換なら乗換抵抗 [分]、最初の乗車なら 0
 */
export function rideCost(inVehicleMin: number, tph: number, transfer: number, throughRunning: boolean, w: GeneralizedCostWeights): CostComponents {
  if (throughRunning) return { ...ZERO_COST, inVehicleMin };
  return { ...ZERO_COST, inVehicleMin, waitMin: waitMinutes(tph, w), transferMin: transfer };
}
