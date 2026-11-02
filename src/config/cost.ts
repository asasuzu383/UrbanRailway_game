/**
 * 費用・収支のパラメータ（docs/design.md §6）。金額は円（税抜・実質、物価上昇は考慮しない）。
 *
 * 主な出典:
 *  [MLIT-R5] 国土交通省「令和５年度 JR旅客会社、大手民鉄及び地下鉄事業者の基準単価及び基準コストの算定に係るデータ一覧」
 *            https://www.mlit.go.jp/tetudo/content/001977442.pdf
 *  [MLIT-R4] 同 令和４年度版 https://www.mlit.go.jp/tetudo/content/001859527.pdf（大手民鉄の輸送人キロ）
 *  [METRO]   東京メトロ 有楽町線延伸（豊洲〜住吉 4.8km, 約2,690億円）・南北線延伸（品川〜白金高輪 2.5km, 約1,310億円）
 *            の事業許可（2022年）https://www.mlit.go.jp/report/press/content/001472839.pdf
 *  [CAO]     内閣府 沖縄鉄軌道に関する調査報告書（整備中の普通鉄道 260〜600億円/km、相鉄・東急直通線 約291億円/km、
 *            横浜市営地下鉄ブルーライン延伸 約265億円/km、宇都宮LRT 約47億円/km）
 *            https://www8.cao.go.jp/okinawa/6/67_r5houkokusyo_3-6.pdf
 *  [E235]    ニュースイッチ「E235系 量産先行車 1両約1億5000万円」(2015) https://newswitch.jp/p/2325
 * 「仮置き」は根拠が弱く、今後見直す値。
 */
import type { StructureType } from '../core/types';

export interface CostParams {
  construction: {
    /** 線路（駅を除く）の km 単価 [円/km] */
    trackPerKm: Record<StructureType, number>;
    /** 駅 1 つあたりの建設費 [円] */
    stationEach: Record<StructureType, number>;
    /** 既存駅に接続する駅（乗換駅）は既存駅の改良として駅単価にこの係数を掛ける */
    transferStationFactor: number;
    /** 待避設備（副本線 2 線とホーム）を 1 駅に設ける費用 [円/駅]（通過運転のある種別を設定したとき） */
    passingLoopEach: Record<StructureType, number>;
    /** 車両 1 両の価格 [円] */
    carPrice: number;
    /** 予備車の割合 */
    spareRatio: number;
  };
  land: {
    /** 用地幅 [m]（地下は用地費なし） */
    widthM: Record<StructureType, number>;
    /** 駅 1 つあたりに追加で必要な用地 [m²]（地平・高架） */
    stationAreaM2: number;
    /** 地価公示価格に掛ける補正係数（買収単価 / 公示価格） */
    priceFactor: number;
  };
  fare: {
    /** 定期外の賃率 [円/人キロ] */
    nonCommuterRatePerKm: number;
    /** 定期の割引率（定期外の賃率に対して） */
    commuterDiscount: number;
    /** 輸送人キロに占める定期の割合 */
    commuterShare: number;
    /** 1 回の乗車の最低運賃（定期外、初乗り）[円] */
    minimumFare: number;
  };
  /** 運行（Phase 2 M3: 種別ごとの本数・両数は路線の運行計画で持つ。ここは既定の計画の値と運行時間帯） */
  service: {
    /** 既定の計画（各停のみ）のピーク 1 時間の片道本数 */
    peakTrainsPerHour: number;
    /** 既定の計画の日中 1 時間の片道本数 */
    offpeakTrainsPerHour: number;
    /** 既定の計画の編成両数 */
    carsPerTrain: number;
    /** ピーク本数で運行する時間 [時/日]（朝夕の合計） */
    peakHoursPerDay: number;
    /** 運行時間 [時/日]（ピーク以外は日中の本数） */
    operatingHoursPerDay: number;
  };
  operating: {
    /** 運転費＋車両保存費 [円/車両キロ] */
    perCarKm: number;
    /** 線路保存費＋電路保存費 [円/km・年]（営業キロあたり） */
    trackMaintenancePerKmYear: Record<StructureType, number>;
    /** 駅の運営費（運輸費）[円/駅・年] */
    stationPerYear: Record<StructureType, number>;
    /** 管理費等（保守管理・輸送管理・案内宣伝・厚生福利・一般管理）の、直接費に対する比率 */
    overheadRatio: number;
  };
  annual: {
    /** 平日・休日の日数と、休日の利用者数の平日比（年平均日 ↔ 平日の換算に使う） */
    weekdays: number;
    holidays: number;
    holidayFactor: number;
  };
  evaluation: {
    /** 割引率（年） */
    discountRate: number;
    /** 開業 1 年目から順の需要係数（以降は最後の値） */
    rampUp: number[];
    /** 回収年数を探す上限 [年] */
    maxYears: number;
  };
}

const OKU = 1e8; // 億円

export const defaultCostParams: CostParams = {
  construction: {
    trackPerKm: {
      // 仮置き。宇都宮LRT 約47億円/km [CAO] を参考に、普通鉄道の地平区間（踏切・立体交差を含む）として設定
      street: 40 * OKU, // 普通鉄道は併用軌道を選べない（型のために地平と同じ値）
      atGrade: 40 * OKU,
      // 仮置き。つくばエクスプレス（高架主体、一部地下）約9,400億円/58.3km ≒ 161億円/km（駅込み）より低めに設定
      elevated: 100 * OKU,
      // [METRO][CAO] 有楽町線延伸・南北線延伸が 1.5 割前後低め、相鉄・東急直通線がやや高めに出るよう駅単価と合わせて設定
      underground: 300 * OKU,
    },
    stationEach: {
      street: 10 * OKU, // 普通鉄道は併用軌道を選べない（型のために地平と同じ値）
      atGrade: 10 * OKU, // 仮置き
      elevated: 40 * OKU, // 仮置き
      underground: 200 * OKU, // [METRO] から逆算（下の検算参照）
    },
    // 仮置き。既存駅のホーム増設・連絡通路の改良として新設の 7 割
    transferStationFactor: 0.7,
    // 仮置き: 副本線 2 線・ホーム延伸として駅単価の 0.6 倍程度（地平 15 億円、高架 40 億円、地下 120 億円）。根拠となる事業費は未確認
    passingLoopEach: { street: 15 * OKU, atGrade: 15 * OKU, elevated: 40 * OKU, underground: 120 * OKU },
    // [E235] 1両 約1.5億円
    carPrice: 1.5 * OKU,
    spareRatio: 0.1, // 仮置き
  },
  land: {
    // 仮置き。複線の線路敷として地平 12m、高架 10m
    widthM: { street: 0, atGrade: 12, elevated: 10, underground: 0 },
    stationAreaM2: 3000, // 仮置き（ホーム 150m × 20m）
    priceFactor: 1.0, // 仮置き
  },
  fare: {
    // [MLIT-R4] 関東大手民鉄 8 社の（定期外＋定期）運賃収入 / 輸送人キロ ≒ 10〜13.5 円（平均 約11.8円）。
    // 収入に占める定期の割合 約39%（東急）と、人キロに占める定期の割合 60%（仮置き）から、
    // 定期外 18 円/人キロ・定期割引 57% とすると平均 11.8 円/人キロになる
    nonCommuterRatePerKm: 18,
    commuterDiscount: 0.57,
    commuterShare: 0.6,
    minimumFare: 150, // 仮置き（大手民鉄の初乗り運賃の水準）
  },
  service: {
    peakTrainsPerHour: 12, // 仮置き
    offpeakTrainsPerHour: 6, // 仮置き
    carsPerTrain: 6, // 仮置き
    // 仮置き: 朝 2 時間＋夕 2 時間をピーク、5 時台〜23 時台の 18 時間運行（片道 12×4 + 6×14 = 132 本/日。Phase 1 の 120 本/日と同程度）
    peakHoursPerDay: 4,
    operatingHoursPerDay: 18,
  },
  operating: {
    // [MLIT-R5] 関東大手民鉄 8 社の（運転費＋車両保存費）/ 旅客車両キロ ≒ 118〜166 円（中央値 約140円）。東京メトロは 約214円
    perCarKm: 140,
    // [MLIT-R5]（線路保存費＋電路保存費）/ 営業キロ: 関東大手民鉄 中央値 約0.7億円、東京メトロ 約2.1億円
    trackMaintenancePerKmYear: { street: 0.6 * OKU, atGrade: 0.6 * OKU, elevated: 0.8 * OKU, underground: 2.0 * OKU },
    // [MLIT-R5] 運輸費 / 駅数: 関東大手民鉄 中央値 約1.5億円、東京メトロ 約3.7億円
    stationPerYear: { street: 1.5 * OKU, atGrade: 1.5 * OKU, elevated: 1.5 * OKU, underground: 3.5 * OKU },
    // [MLIT-R5] 管理費等 / それ以外の営業費（減価償却費・諸税を除く）: 京王 33%、西武 36%、小田急 41%、京急 41%、東急 43%
    overheadRatio: 0.35,
  },
  annual: {
    weekdays: 245,
    holidays: 120,
    holidayFactor: 0.7, // 仮置き
  },
  evaluation: {
    // 国土交通省の事業評価で用いる社会的割引率 4%
    discountRate: 0.04,
    rampUp: [0.7, 0.8, 0.9, 0.95, 1.0], // 仮置き
    maxYears: 100,
  },
};

/*
 * 検算（地下）: 有楽町線延伸 4.8km・新駅 3・接続駅 2 → 300×4.8 + 200×3 + 200×0.7×2 = 2,320億円（実際 約2,690億円、−14%）
 *               南北線延伸 2.5km・新駅 1・接続駅 1 → 300×2.5 + 200 + 140 = 1,090億円（実際 約1,310億円、−17%）
 *               相鉄・東急直通線 約10km・新駅 2 → 300×10 + 400 = 3,400億円（実際 約2,900億円、+17%）
 * 運行経費の検算: 京王（車両キロ 1.24億、営業キロ 84.7、駅 69）→ 1.24億×140 + 84.7×0.7億 + 69×1.5億 = 333億、×1.35 = 449億円
 *               （実際の営業費 減価償却費・諸税除く 491億円）
 */
