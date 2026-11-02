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

/** 交通機関タイプ（パラメータは src/config/transitTypes.ts） */
export type TransitTypeId = 'heavyRail' | 'monorail' | 'agt' | 'lrt';

/** 区間の構造。street = 併用軌道（道路上。LRT のみ）、atGrade = 地平（LRT では専用軌道） */
export type StructureType = 'street' | 'atGrade' | 'elevated' | 'underground';

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
  /** 交通機関タイプ（src/config/transitTypes.ts）。省略時は普通鉄道 */
  readonly transitType?: TransitTypeId;
  /** 配置順。先頭と末尾は必ず駅 */
  readonly vertices: readonly LineVertex[];
  readonly segments: readonly SegmentAttributes[];
}

/** 保存・エクスポート単位。将来は複数路線・運行計画を含む。 */
/** シナリオの保存形式の版。1 = Phase 1（路線のみ）、2 = Phase 2（運行計画・交通機関タイプ）。古い版は読み込み時に移行する */
export const SCENARIO_SCHEMA_VERSION = 2;

export interface Scenario {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly lines: readonly UserLine[];
  /** 路線ごとの運行計画（無い路線は既定の計画 = 各停のみ） */
  readonly servicePlans: readonly ServicePlan[];
}

// ---------------------------------------------------------------------------
// 運行計画（Phase 2 M3。docs/design.md §14）
// ---------------------------------------------------------------------------

/** 運行計画の種別は最大 3 つ（例: 各停・快速・急行） */
export const MAX_SERVICE_PATTERNS = 3;

export interface ServicePattern {
  readonly id: string;
  /** 列車種別名（例: 各停, 快速） */
  readonly name: string;
  /** 停車駅（StationVertex.id）。null は全駅停車。起点・終点には必ず停車する */
  readonly stopStationIds: readonly string[] | null;
  /** ピーク 1 時間の片道本数 [本/時] */
  readonly tphPeak: number;
  /** 日中 1 時間の片道本数 [本/時] */
  readonly tphOffpeak: number;
  readonly carsPerTrain: number;
}

/** 新線の端の接続駅から既存の運行系統へ直通する（乗換抵抗・待ち時間なし） */
export interface ThroughRunning {
  /** 新線の起点または終点の接続駅（StationVertex.id） */
  readonly atStationId: string;
  /** 直通先の既存の運行系統（services.json の routes[].id） */
  readonly routeId: string;
}

export interface ServicePlan {
  readonly lineId: string;
  readonly patterns: readonly ServicePattern[];
  readonly through: readonly ThroughRunning[];
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
  /** 駅勢圏の Huff 按分後人口・従業者数（説明用。接続駅は既存駅と一体なので null） */
  readonly catchmentPopulation: number | null;
  readonly catchmentEmployees: number | null;
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
  /**
   * 輸送人員の内訳 [人/日]。
   * local: 両端とも新線の駅勢圏、toExisting: 片方が既存線方面（接続駅で乗換）、
   * through: 両端とも既存線方面（既存線から新線経由に経路を変えた短絡利用）
   */
  readonly tripsByType: { readonly local: number; readonly toExisting: number; readonly through: number };
  /** 新線によって鉄道を使うようになった人口（駅勢圏の鉄道利用確率の増分 × 人口） [人] */
  readonly newRailUsersPopulation: number;
}

// ---------------------------------------------------------------------------
// 費用・収支の結果（金額はすべて円）
// ---------------------------------------------------------------------------

export interface StructureCost {
  readonly lengthKm: number;
  readonly trackCost: number;
  readonly stationCount: number;
  readonly stationCost: number;
  readonly landCost: number;
}

export interface ConstructionCostBreakdown {
  readonly byStructure: Readonly<Record<StructureType, StructureCost>>;
  readonly vehicles: { readonly cars: number; readonly trainsets: number; readonly cost: number };
  /** 待避設備（通過運転のある種別があるとき。stations は geometry.stations の添字） */
  readonly passing: { readonly stations: readonly number[]; readonly cost: number };
  /** 地価データが無く用地費を計算できなかった区間がある */
  readonly landPriceMissing: boolean;
  readonly total: number;
}

export interface OperatingCostBreakdown {
  readonly train: number;
  readonly track: number;
  readonly stations: number;
  readonly overhead: number;
  readonly total: number;
  /** 年間の車両走行キロ */
  readonly carKm: number;
}

export interface AnnualFinance {
  /** 開業後年数（0 = 建設費を計上する開業時点、1 = 開業初年度） */
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
  /** 定常状態（需要の立ち上がり後）の年間値 */
  readonly steadyRevenue: number;
  readonly steadyOperatingCost: OperatingCostBreakdown;
  readonly steadyOperatingBalance: number;
  /** 平日・休日 1 日あたりの輸送人員（年平均日から換算） */
  readonly weekdayPassengers: number;
  readonly holidayPassengers: number;
  /** 平均運賃（輸送人員 1 人あたり）[円] */
  readonly averageFare: number;
  readonly isProfitable: boolean;
  /** 回収不能なら null */
  readonly simplePaybackYears: number | null;
  readonly discountedPaybackYears: number | null;
  readonly timeline: readonly AnnualFinance[];
}
