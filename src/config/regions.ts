/**
 * 地域の設定（docs/design.md §12）。
 * データ（public/data/<dataDir>/）・需要モデルの校正値・費用単価・地図の初期範囲を地域ごとに持つ。
 * Phase 2 時点では首都圏のみ。地域を追加するときは scripts/config/regions/<id>/region.yaml を作って前処理・校正を
 * `--region <id>` で実行し、ここに 1 項目足す。
 */
import { defaultCostParams, type CostParams } from './cost';
import type { DemandParams } from './demand';
import shutokenDemand from './regions/shutoken/demand.calibrated.json';

export type RegionId = 'shutoken';

export interface RegionConfig {
  readonly id: RegionId;
  /** 地域名（UI 表示用） */
  readonly name: string;
  /** アプリのタイトル */
  readonly title: string;
  /** 加工済みデータの置き場所（public/data/ の下） */
  readonly dataDir: string;
  /** 地図の初期表示範囲 [西, 南, 東, 北] */
  readonly initialBounds: readonly [number, number, number, number];
  /** 需要モデルのパラメータ（scripts/calibrate.py --region <id> の出力） */
  readonly demandParams: DemandParams;
  /** 費用・運賃・運行の単価の初期値（地域の実績に基づく値。出典は src/config/cost.ts） */
  readonly costParams: CostParams;
  /** localStorage のキー（地域ごとに分ける。首都圏は Phase 1 からのキーをそのまま使う） */
  readonly storageKeys: { readonly scenario: string; readonly costParams: string };
}

export const REGIONS: Readonly<Record<RegionId, RegionConfig>> = {
  shutoken: {
    id: 'shutoken',
    name: '首都圏',
    title: '首都圏 鉄道新線計画シミュレーター',
    dataDir: 'shutoken',
    initialBounds: [139.0, 35.1, 140.6, 36.2],
    demandParams: shutokenDemand,
    // 関東の大手民鉄・東京メトロの実績から設定した値（src/config/cost.ts）
    costParams: defaultCostParams,
    storageKeys: { scenario: 'urbanrailway.scenario.v1', costParams: 'urbanrailway.costParams.v1' },
  },
};

/** 現在の地域（Phase 2 は首都圏のみ。地域の選択 UI は全国展開のときに追加する） */
export const CURRENT_REGION: RegionConfig = REGIONS.shutoken;
