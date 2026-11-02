/**
 * 交通機関タイプごとのパラメータセット（Phase 2 M4。docs/design.md §15）。
 * 1 路線につき 1 タイプ（UserLine.transitType）。選べる構造、走行性能、輸送力、建設・車両・運行経費、運賃を持つ。
 *
 * 出典（[記号] で参照）:
 *   [CAO]  内閣府「沖縄鉄軌道の構造等に関する検討調査」令和5年度報告書 第2章（https://www8.cao.go.jp/okinawa/6/67_r5houkokusyo_3-6.pdf）
 *          大阪モノレール線延伸線（門真市・瓜生堂間 約8.9km、4 駅、全線高架）約1,050 億円（約118 億円/km）、
 *          宇都宮ライトレール 約47 億円/km、既存 AGT の新製車両 約1.6 億円/両（5両12編成 94 億円、最高 60km/h）、
 *          トラムトレイン 約4.4 億円/編成（5 車体）、普通鉄道の新製車両 約1.5〜2.5 億円/両
 *   [MLIT-C] 国土交通省「最混雑区間における混雑率（令和6年度）」の輸送力 ÷（編成両数 × 本数）＝ 1 両あたり定員:
 *          JR 約148、東京メトロ 約150、多摩都市モノレール 約103、東京モノレール 約97、ゆりかもめ 約51、日暮里・舎人ライナー 約51、
 *          広島電鉄（連接車の 1 車体）約50
 *   [軌道] 軌道運転規則 第53条（併用軌道の車両の運転速度: 最高 40km/h 以下、平均 30km/h 以下）
 * 普通鉄道の費用・運賃は src/config/cost.ts（パラメータ画面で変更できる値）をそのまま使い、ここでは上書きしない。
 */
import type { StructureType, TransitTypeId } from '../core/types';

export type { TransitTypeId };

/** 普通鉄道以外のタイプで費用パラメータ（src/config/cost.ts）を上書きする値 [円] */
export interface TransitCostOverrides {
  readonly trackPerKm: Partial<Record<StructureType, number>>;
  readonly stationEach: Partial<Record<StructureType, number>>;
  readonly passingLoopEach: Partial<Record<StructureType, number>>;
  readonly landWidthM: Partial<Record<StructureType, number>>;
  readonly carPrice: number;
  readonly perCarKm: number;
  readonly trackMaintenancePerKmYear: Partial<Record<StructureType, number>>;
  readonly stationPerYear: Partial<Record<StructureType, number>>;
  /** 定期外の賃率 [円/km] と最低運賃 [円] */
  readonly fareBaseRatePerKm: number;
  readonly fareMinimum: number;
}

export interface TransitTypeParams {
  readonly id: TransitTypeId;
  readonly name: string;
  /** 選べる構造（UI で選べない構造があれば変更を促す） */
  readonly structures: readonly StructureType[];
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
  /** 1 両（連接車は 1 車体）あたりの定員 [人] */
  readonly capacityPerCar: number;
  /** 1 編成の最大両数 */
  readonly maxCarsPerTrain: number;
  /** 最小運転間隔 [分]（片方向。これより短い間隔の計画は警告） */
  readonly minHeadwayMin: number;
  /** 併用軌道（street）の最高速度 [km/h] と平均速度の上限 [km/h]、信号待ちなどの遅れ [分/km] */
  readonly street?: { readonly maxSpeedKmh: number; readonly maxAverageKmh: number; readonly signalDelayMinPerKm: number };
  /** インフラ部が公費整備（インフラ補助）の対象になりうる（Phase 4 の事業スキームで使う。今は計算に使わない） */
  readonly infraSubsidyEligible: boolean;
  /** 普通鉄道以外の費用・運賃（null は src/config/cost.ts の値をそのまま使う） */
  readonly costs: TransitCostOverrides | null;
}

const OKU = 1e8;

export const TRANSIT_TYPES: Readonly<Record<TransitTypeId, TransitTypeParams>> = {
  /**
   * 普通鉄道。走行性能は既存線の公表資料ベースの所要時間計算（regions/<地域>/services.yaml の runtime）と揃える。
   * 加速度 3.0 km/h/s は E233 系などの起動加速度（仮置き: 形式は特定しない）、減速度・停車時間・最高速度 110 km/h・折返し 10 分は仮置き、
   * 余裕係数 1.15 は都営地下鉄の時刻表との比較（design.md §11.3）。定員 150 人/両 [MLIT-C]。最小運転間隔 2 分（仮置き）。
   */
  heavyRail: {
    id: 'heavyRail',
    name: '普通鉄道',
    structures: ['atGrade', 'elevated', 'underground'],
    maxSpeedKmh: 110,
    accelKmhPerS: 3.0,
    decelKmhPerS: 3.5,
    dwellSec: 30,
    dwellTransferSec: 50,
    runtimeMargin: 1.15,
    turnbackMin: 10,
    capacityPerCar: 150,
    maxCarsPerTrain: 15,
    minHeadwayMin: 2,
    infraSubsidyEligible: false,
    costs: null,
  },
  /**
   * 跨座式モノレール。原則高架（地下・地平は選べない）。定員 100 人/両 [MLIT-C 多摩 103・東京 97]。
   * 建設費: 大阪モノレール延伸 約118 億円/km（4 駅込み）[CAO] から、駅 15 億円（仮置き）を除いて線路 110 億円/km。
   * 最高速度 70 km/h（大阪 75・多摩 65 km/h 程度。仮置き）、加減速度・停車・折返し・最小間隔 3 分は仮置き。
   * 車両 2.0 億円/両は普通鉄道の範囲 [CAO] の中間（仮置き）。経費・運賃は仮置き（モノレールは初乗りが高めの例が多い）。
   */
  monorail: {
    id: 'monorail',
    name: 'モノレール',
    structures: ['elevated'],
    maxSpeedKmh: 70,
    accelKmhPerS: 3.5,
    decelKmhPerS: 4.0,
    dwellSec: 30,
    dwellTransferSec: 40,
    runtimeMargin: 1.15,
    turnbackMin: 6,
    capacityPerCar: 100,
    maxCarsPerTrain: 6,
    minHeadwayMin: 3,
    infraSubsidyEligible: true,
    costs: {
      trackPerKm: { elevated: 110 * OKU },
      stationEach: { elevated: 15 * OKU },
      passingLoopEach: { elevated: 30 * OKU },
      landWidthM: { elevated: 3 }, // 仮置き: 道路上の支柱の用地
      carPrice: 2.0 * OKU,
      perCarKm: 140,
      trackMaintenancePerKmYear: { elevated: 1.0 * OKU },
      stationPerYear: { elevated: 1.0 * OKU },
      fareBaseRatePerKm: 25,
      fareMinimum: 200,
    },
  },
  /**
   * 新交通システム（AGT、案内軌条式）。原則高架。最高速度 60 km/h・車両 約1.6 億円/両 [CAO]、定員 50 人/両 [MLIT-C]。
   * 建設費は沖縄のモデルルートの AGT の概算（約89〜122 億円/km、駅込み）[CAO] を参考に線路 85 億円/km・駅 12 億円（仮置き）。
   * 加減速度・停車・折返し・最小間隔 2.5 分（ゆりかもめ・日暮里舎人のピーク 16〜19 本/時を参考）・経費・運賃は仮置き。
   */
  agt: {
    id: 'agt',
    name: '新交通システム（AGT）',
    structures: ['elevated'],
    maxSpeedKmh: 60,
    accelKmhPerS: 3.5,
    decelKmhPerS: 4.5,
    dwellSec: 25,
    dwellTransferSec: 35,
    runtimeMargin: 1.15,
    turnbackMin: 5,
    capacityPerCar: 50,
    maxCarsPerTrain: 6,
    minHeadwayMin: 2.5,
    infraSubsidyEligible: true,
    costs: {
      trackPerKm: { elevated: 85 * OKU },
      stationEach: { elevated: 12 * OKU },
      passingLoopEach: { elevated: 25 * OKU },
      landWidthM: { elevated: 3 },
      carPrice: 1.6 * OKU,
      perCarKm: 100,
      trackMaintenancePerKmYear: { elevated: 0.8 * OKU },
      stationPerYear: { elevated: 0.8 * OKU },
      fareBaseRatePerKm: 25,
      fareMinimum: 190,
    },
  },
  /**
   * LRT（路面電車の発展形。両数は連接車の車体数）。併用軌道・専用軌道（地平）・高架を選べる。
   * 併用軌道は最高 40 km/h・平均 30 km/h 以下 [軌道]、信号待ちなどの遅れ 0.5 分/km（仮置き）。専用軌道の最高速度 70 km/h（仮置き）。
   * 定員 50 人/車体 [MLIT-C 広島電鉄]、既定の 1 編成は 3 車体（運行計画で変える）。車両 0.9 億円/車体（トラムトレイン 4.4 億円/5 車体 [CAO]）。
   * 建設費は宇都宮ライトレール 約47 億円/km（停留場・車両込み）[CAO] を参考に、併用軌道 25・専用軌道 35・高架 90 億円/km、停留場 1 億円（仮置き）。
   * 経費・運賃（均一運賃に近い）は仮置き。
   */
  lrt: {
    id: 'lrt',
    name: 'LRT',
    structures: ['street', 'atGrade', 'elevated'],
    maxSpeedKmh: 70,
    accelKmhPerS: 3.5,
    decelKmhPerS: 4.5,
    dwellSec: 20,
    dwellTransferSec: 30,
    runtimeMargin: 1.15,
    turnbackMin: 5,
    capacityPerCar: 50,
    maxCarsPerTrain: 5,
    minHeadwayMin: 3,
    street: { maxSpeedKmh: 40, maxAverageKmh: 30, signalDelayMinPerKm: 0.5 },
    infraSubsidyEligible: false,
    costs: {
      trackPerKm: { street: 25 * OKU, atGrade: 35 * OKU, elevated: 90 * OKU },
      stationEach: { street: 1 * OKU, atGrade: 1 * OKU, elevated: 8 * OKU },
      passingLoopEach: { street: 3 * OKU, atGrade: 3 * OKU, elevated: 15 * OKU },
      landWidthM: { street: 0, atGrade: 8, elevated: 3 },
      carPrice: 0.9 * OKU,
      perCarKm: 120,
      trackMaintenancePerKmYear: { street: 0.3 * OKU, atGrade: 0.3 * OKU, elevated: 0.5 * OKU },
      stationPerYear: { street: 0.1 * OKU, atGrade: 0.1 * OKU, elevated: 0.3 * OKU },
      fareBaseRatePerKm: 15,
      fareMinimum: 150,
    },
  },
};

export const DEFAULT_TRANSIT_TYPE: TransitTypeId = 'heavyRail';
export const TRANSIT_TYPE_ORDER: readonly TransitTypeId[] = ['heavyRail', 'monorail', 'agt', 'lrt'];
