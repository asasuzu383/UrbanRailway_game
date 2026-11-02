/**
 * 需要モデルのパラメータ。
 * 値は scripts/calibrate.py が地域ごとに書き出す regions/<地域>/demand.calibrated.json から読む（固定値の定義元は
 * scripts/config/demand.yaml、校正値は S12 に対する推定結果）。根拠は docs/design.md §4 と docs/calibration.md。
 */
import type { GeneralizedCostWeights } from '../core/generalizedCost';
import { CURRENT_REGION } from './regions';

export interface DemandParams {
  /** 地域 ID（src/config/regions.ts） */
  readonly region: string;
  /** 都心の基準点 [経度, 緯度]（外部選択肢の「都心からの距離」の基準。地域の設定 region.yaml の core_point） */
  readonly corePoint: readonly number[];
  /** 魅力度 A = (ACC / accRef)^α の基準化定数 */
  readonly accRef: number;
  readonly access: {
    /** 直線距離 → 道のり距離の迂回係数（仮置き） */
    readonly detourFactor: number;
    /** 駅勢圏の上限（道のり距離, km） */
    readonly maxAccessKm: number;
  };
  readonly mass: {
    /** 集中量に加える夜間人口の重み ψ（仮置き） */
    readonly populationWeight: number;
  };
  readonly network: {
    readonly transferSameOperatorMin: number;
    /** 他事業者・新線との乗換抵抗 [分]（仮置き） */
    readonly transferOtherOperatorMin: number;
    readonly walkSpeedKmh: number;
    readonly walkDetourFactor: number;
  };
  readonly service: {
    /** 新線の表定速度 [km/h]（Phase 1 は固定、仮置き） */
    readonly scheduledSpeedKmh: number;
    /** 新線の代表本数 [本/時]（待ち時間の計算用。Phase 2 M3 で運行計画の本数に置き換える。仮置き） */
    readonly representativeTph: number;
  };
  /** 一般化費用の重み（src/core/generalizedCost.ts、docs/design.md §13） */
  readonly generalizedCost: GeneralizedCostWeights;
  readonly shortcut: {
    readonly neighborhoodMin: number;
    /** 既存経路と新線経由の経路選択ロジットの時間感度 [1/分]（仮置き） */
    readonly routeLogitPerMin: number;
  };
  /** 校正値（docs/calibration.md） */
  readonly fitted: {
    /** β: 駅までの距離減衰 [1/km] */
    readonly accessDecayPerKm: number;
    /** α: 駅の魅力度指数 */
    readonly attractivenessExponent: number;
    /** a₀, a₁: 鉄道を使わない選択肢の効用 exp(a₀ + a₁·都心距離km) */
    readonly outsideConst: number;
    readonly outsidePerKm: number;
    /** ρ: 駅勢圏で従業者 1 人を人口何人分とみなすか */
    readonly employeeWeight: number;
    /** γ: 所要時間の減衰 [1/分] */
    readonly timeDecayPerMin: number;
    /** c₀, η, θ: ln μ = c₀ + η ln(駅勢圏) + θ ln(ACC/accRef) */
    readonly intercept: number;
    readonly catchmentElasticity: number;
    readonly accessibilityElasticity: number;
    /** κ: 校正時のみ使う路線数の項（新線の推計では使わない） */
    readonly hubElasticity: number;
  };
}

/** 現在の地域の需要モデルのパラメータ */
export const defaultDemandParams: DemandParams = CURRENT_REGION.demandParams;
