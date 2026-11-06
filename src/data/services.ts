/**
 * 既存ネットワークの運行データ（public/data/<地域>/services.json。scripts/06_services.py、docs/design.md §11）。
 * ブラウザでは新線の直通先の選択と、直通先の系統の駅までの所要時間に使う。
 */

/**
 * データ品質（所要時間の出所）: 時刻表ベース（ODPT のオープンデータ）／公表資料（公表の所要時間）／
 * 物理推定（入力値: 公表資料の停車駅と最高速度から運転曲線で計算）／
 * 物理推定（既定値: 停車駅か最高速度が既定値。系統を定義していない線は全駅停車の各停）／仮置き
 */
export type ServiceQuality = 'timetable' | 'published' | 'estimated' | 'estimated_default' | 'provisional';

export const SERVICE_QUALITY_LABEL: Record<ServiceQuality, string> = {
  timetable: '時刻表',
  published: '公表資料',
  estimated: '物理推定（入力値）',
  estimated_default: '物理推定（既定値）',
  provisional: '仮置き',
};

/** 項目ごとの品質（該当しない項目は null。最高速度は物理推定の系統だけ） */
export interface QualityDetail {
  readonly stops: ServiceQuality | null;
  readonly runTime: ServiceQuality | null;
  readonly maxSpeed: ServiceQuality | null;
  readonly peak: ServiceQuality | null;
  readonly offpeak: ServiceQuality | null;
}

const QUALITY_ITEM_LABEL: Record<keyof QualityDetail, string> = {
  runTime: '所要時間',
  stops: '停車駅',
  maxSpeed: '最高速度',
  peak: 'ピーク本数',
  offpeak: '日中本数',
};

/** 品質の説明文（例: 「所要時間 物理推定、停車駅 公表資料、…」） */
export function describeQuality(detail: QualityDetail | null | undefined): string {
  if (!detail) return '';
  return (Object.keys(QUALITY_ITEM_LABEL) as (keyof QualityDetail)[])
    .filter((k) => detail[k])
    .map((k) => `${QUALITY_ITEM_LABEL[k]} ${SERVICE_QUALITY_LABEL[detail[k]!]}`)
    .join('、');
}

export interface ExistingService {
  readonly name: string;
  /** 停車駅（route.stations の位置） */
  readonly stops: readonly number[];
  /** 停車駅間の所要時間 [分] */
  readonly legMinutes: readonly (number | null)[];
  readonly tph: { readonly peak: number; readonly offpeak: number };
}

export interface ExistingRoute {
  readonly id: string;
  readonly name: string;
  readonly operator: string;
  readonly quality: ServiceQuality;
  readonly qualityDetail?: QualityDetail;
  /** stations.json の添字（走行順） */
  readonly stations: readonly number[];
  readonly cars: number | null;
  readonly services: readonly ExistingService[];
}

export interface ServicesFile {
  readonly version: number;
  readonly routes: readonly ExistingRoute[];
  /** network.json の lines ごとの品質（所要時間の出所） */
  readonly lineQuality: readonly ServiceQuality[];
  /** network.json の lines ごとの項目別の品質 */
  readonly lineQualityDetail?: readonly QualityDetail[];
}

/** 既存駅を通る系統（直通先の候補） */
export function routesAtStation(file: ServicesFile, stationIdx: number): ExistingRoute[] {
  return file.routes.filter((r) => r.stations.includes(stationIdx));
}

/**
 * 系統 route に stationIdx から乗ったとき、各停車駅（既存駅の添字）までの乗車時間 [分]。
 * その駅に停まる種別のうちピーク本数の多いもの（主な種別）で測る。両方向とも求める。
 */
export function rideTimesFrom(route: ExistingRoute, stationIdx: number): Map<number, number> {
  const out = new Map<number, number>();
  const pos = route.stations.indexOf(stationIdx);
  if (pos < 0) return out;
  const svc = [...route.services]
    .filter((s) => s.stops.includes(pos))
    .sort((a, b) => b.tph.peak - a.tph.peak)[0];
  if (!svc) return out;
  const k = svc.stops.indexOf(pos);
  for (const dir of [1, -1]) {
    let acc = 0;
    for (let j = k + dir; j >= 0 && j < svc.stops.length; j += dir) {
      const leg = svc.legMinutes[dir > 0 ? j - 1 : j];
      if (leg === null || leg === undefined) break;
      acc += leg;
      out.set(route.stations[svc.stops[j]!]!, acc);
    }
  }
  return out;
}
