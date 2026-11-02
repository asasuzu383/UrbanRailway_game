/**
 * 既存ネットワークの運行データ（public/data/<地域>/services.json。scripts/06_services.py、docs/design.md §11）。
 * ブラウザでは新線の直通先の選択と、直通先の系統の駅までの所要時間に使う。
 */

export type ServiceQuality = 'timetable' | 'published' | 'provisional';

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
  /** stations.json の添字（走行順） */
  readonly stations: readonly number[];
  readonly cars: number | null;
  readonly services: readonly ExistingService[];
}

export interface ServicesFile {
  readonly version: number;
  readonly routes: readonly ExistingRoute[];
  /** network.json の lines ごとの品質 */
  readonly lineQuality: readonly ServiceQuality[];
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
