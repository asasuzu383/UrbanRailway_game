/**
 * ドメイン型定義（全モジュール共通）。
 *
 * 依存方向: core ← data / network ← demand ← finance ← state ← ui
 * core はどのモジュールにも依存しない。詳細は docs/design.md を参照。
 */

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** [経度, 緯度]（WGS84 / JGD2011 を同一視）。GeoJSON と同じ順序。 */
export type LngLat = readonly [lng: number, lat: number];

// ---------------------------------------------------------------------------
// ゾーン（需要の空間単位）
// ---------------------------------------------------------------------------

/**
 * 需要推計の空間単位。Phase 1 は 500m メッシュだが、将来 PT 調査ゾーン等に
 * 差し替えられるよう、メッシュ固有の情報は id 以外に持たせない。
 */
export interface Zone {
  /** メッシュコード（JIS X 0410）またはゾーンID */
  readonly id: string;
  readonly centroid: LngLat;
  /** 夜間人口（国勢調査） */
  readonly population: number;
  /** 従業者数（経済センサス） */
  readonly employees: number;
  /** 都心（東京駅）からの直線距離 [km]。前処理で付与 */
  readonly distToCoreKm: number;
}

// ---------------------------------------------------------------------------
// 既存鉄道ネットワーク（前処理済みデータ）
// ---------------------------------------------------------------------------

/** 物理的な駅（同名・近接の事業者別駅をまとめた「駅グループ」）。 */
export interface ExistingStation {
  readonly id: string;
  readonly name: string;
  readonly position: LngLat;
  /** 乗り入れ路線ID */
  readonly lineIds: readonly string[];
  readonly operators: readonly string[];
  /** S12 の 1日平均乗降客数（グループ合計）。データ無しは null */
  readonly observedRidership: number | null;
  /**
   * 既存ネットワーク上の到達圏指標 ACC_k（重力型アクセシビリティ）。
   * 校正済みパラメータで前処理時に計算。docs/design.md §4.3。
   */
  readonly accessibility: number;
}

export interface ExistingLine {
  readonly id: string;
  readonly name: string;
  readonly operator: string;
  /** 事業者種別（N02_002）: 1=JR新幹線, 2=JR在来線, 3=公営, 4=民営, 5=第三セクター */
  readonly operatorType: number;
  readonly color: string;
}

// ---------------------------------------------------------------------------
// ユーザーが作る路線（エディタのモデル）
// ---------------------------------------------------------------------------

export type StructureType = 'atGrade' | 'elevated' | 'underground';

/** 路線上の頂点。駅または中間点（曲線形状用）。 */
export type LineVertex = StationVertex | ShapeVertex;

export interface StationVertex {
  readonly kind: 'station';
  readonly id: string;
  readonly position: LngLat;
  readonly name: string;
  /** 既存駅にスナップした場合の既存駅ID（＝接続駅） */
  readonly transferTo: string | null;
}

export interface ShapeVertex {
  readonly kind: 'shape';
  readonly id: string;
  readonly position: LngLat;
}

/**
 * 区間 = 隣り合う 2 駅の間（間の中間点を含む）。
 * 構造は区間単位で持つ。将来は区間内の部分構造（トンネル坑口位置など）に拡張。
 */
export interface SegmentAttributes {
  /** 区間の起点駅の vertex id（区間の識別子として使う） */
  readonly fromStationId: string;
  readonly structure: StructureType;
}

export interface UserLine {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** 配置順。先頭と末尾は必ず駅 */
  readonly vertices: readonly LineVertex[];
  readonly segments: readonly SegmentAttributes[];
}

/** 保存・エクスポート単位。将来は複数路線・運行計画を含む。 */
export interface Scenario {
  readonly schemaVersion: 1;
  readonly lines: readonly UserLine[];
  /** Phase 1 は未使用（固定デフォルト）。将来の運行体系設定用 */
  readonly servicePlans?: readonly ServicePlan[];
}

// ---------------------------------------------------------------------------
// 運行計画（Phase 1 では固定値。型だけ先に定義）
// ---------------------------------------------------------------------------

export interface ServicePlan {
  readonly lineId: string;
  readonly patterns: readonly ServicePattern[];
}

export interface ServicePattern {
  /** 列車種別名（例: 各停, 快速） */
  readonly name: string;
  /** 停車駅（StationVertex.id）。各停なら全駅 */
  readonly stopStationIds: readonly string[];
  /** 片道の1日運行本数 */
  readonly trainsPerDayOneWay: number;
  /** ピーク時 片道運行本数 [本/h] */
  readonly peakTrainsPerHour: number;
  readonly carsPerTrain: number;
  /** 表定速度 [km/h] */
  readonly scheduledSpeedKmh: number;
}

// ---------------------------------------------------------------------------
// 需要推計の結果
// ---------------------------------------------------------------------------

export interface StationDemand {
  readonly stationId: string;
  /** 新線の 1日平均乗降人員（乗換客を含む） */
  readonly ridership: number;
  /** 内訳: 駅勢圏から発生・集中するトリップ端 */
  readonly fromCatchment: number;
  /** 内訳: 接続駅での他路線との乗換 */
  readonly fromTransfer: number;
  /** 駅勢圏の Huff 按分後人口・従業者数（説明用） */
  readonly catchmentPopulation: number;
  readonly catchmentEmployees: number;
}

export interface SegmentLoad {
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly lengthKm: number;
  /** 断面輸送量 [人/日]（方向別） */
  readonly forward: number;
  readonly backward: number;
}

export interface DemandResult {
  readonly stations: readonly StationDemand[];
  readonly segments: readonly SegmentLoad[];
  /** 新線区間の OD 表 [人/日]。キーは駅IDまたは外部ポータル ID */
  readonly od: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** 1日平均輸送人員（新線の乗車人員） */
  readonly dailyPassengers: number;
  /** 1日平均輸送人キロ（新線区間のみ） */
  readonly dailyPassengerKm: number;
}

// ---------------------------------------------------------------------------
// 費用・収支の結果
// ---------------------------------------------------------------------------

export interface ConstructionCostBreakdown {
  readonly byStructure: Readonly<Record<StructureType, { lengthKm: number; trackCost: number; stationCount: number; stationCost: number; landCost: number }>>;
  /** 合計 [円] */
  readonly total: number;
}

export interface AnnualFinance {
  /** 開業後年数（1 = 開業初年度） */
  readonly year: number;
  readonly demandFactor: number;
  readonly revenue: number;
  readonly operatingCost: number;
  /** 営業収支（減価償却前） */
  readonly operatingBalance: number;
  readonly cumulativeCashFlow: number;
  readonly cumulativeDiscountedCashFlow: number;
}

export interface FinanceResult {
  readonly construction: ConstructionCostBreakdown;
  /** 定常状態の年間値 */
  readonly steadyRevenue: number;
  readonly steadyOperatingCost: number;
  readonly steadyOperatingBalance: number;
  readonly isProfitable: boolean;
  /** 回収不能なら null */
  readonly simplePaybackYears: number | null;
  readonly discountedPaybackYears: number | null;
  readonly timeline: readonly AnnualFinance[];
}
