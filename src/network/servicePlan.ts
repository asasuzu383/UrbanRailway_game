/**
 * 新線の運行計画（Phase 2 M3。docs/design.md §14）: 種別ごとの所要時間、必要編成数、車両キロ、待避設備の要否。
 */
import type { TransitTypeParams } from '../config/transitTypes';
import { MAX_SERVICE_PATTERNS, type ServicePattern, type ServicePlan, type UserLine } from '../core/types';
import type { LineGeometry } from './lineGeometry';
import { legMinutes } from './runtime';

/** 既定の運行計画の値（費用パラメータの service から渡す） */
export interface PlanDefaults {
  readonly tphPeak: number;
  readonly tphOffpeak: number;
  readonly carsPerTrain: number;
}

/** 運行の時間帯の設定（費用パラメータの service から渡す） */
export interface OperatingHours {
  /** ピーク本数で運行する時間 [時/日]（朝夕の合計） */
  readonly peakHoursPerDay: number;
  /** 運行時間 [時/日]（ピーク以外は日中の本数で運行） */
  readonly operatingHoursPerDay: number;
}

export function defaultServicePlan(line: UserLine, d: PlanDefaults): ServicePlan {
  return {
    lineId: line.id,
    patterns: [{ id: 'local', name: '各停', stopStationIds: null, tphPeak: d.tphPeak, tphOffpeak: d.tphOffpeak, carsPerTrain: d.carsPerTrain }],
    through: [],
  };
}

/**
 * 計画を路線に合わせて整える: 種別は 1〜3 つ、停車駅は路線にある駅だけ、起点・終点には必ず停車、
 * 直通は起点・終点の接続駅だけ。
 */
export function normalizePlan(plan: ServicePlan | undefined, line: UserLine, geo: LineGeometry, d: PlanDefaults): ServicePlan {
  if (!plan || plan.patterns.length === 0) return defaultServicePlan(line, d);
  const ids = geo.stations.map((s) => s.id);
  const first = ids[0];
  const last = ids[ids.length - 1];
  const patterns = plan.patterns.slice(0, MAX_SERVICE_PATTERNS).map((p) => {
    if (p.stopStationIds === null) return p;
    const set = new Set(p.stopStationIds);
    if (first) set.add(first);
    if (last) set.add(last);
    return { ...p, stopStationIds: ids.filter((id) => set.has(id)) };
  });
  const ends = new Set([first, last].filter((x): x is string => !!x));
  const transfer = new Set(geo.stations.filter((s) => s.transferTo).map((s) => s.id));
  const through = plan.through.filter((t) => ends.has(t.atStationId) && transfer.has(t.atStationId));
  return { lineId: line.id, patterns, through };
}

export interface PatternOperation {
  readonly pattern: ServicePattern;
  /** geo.stations の各駅に停車するか */
  readonly stops: readonly boolean[];
  /** 起点を出てからの所要時間 [分]（停車駅のみ。通過駅は NaN） */
  readonly cumMin: readonly number[];
  /** 片道の所要時間 [分] */
  readonly oneWayMin: number;
  /** 往復の所要時間（両端の折返し込み）[分] */
  readonly cycleMin: number;
  /** ピークに必要な編成数（予備を除く） */
  readonly trainsets: number;
}

export interface LinePlanOperation {
  readonly patterns: readonly PatternOperation[];
  /** geo.stations ごとの起点からのキロ程 [km] */
  readonly chainageKm: readonly number[];
  /** 待避設備が必要な駅（geo.stations の添字） */
  readonly passingStations: readonly number[];
  /** 必要編成数の合計（予備を除く） */
  readonly trainsets: number;
  /** 必要車両数（予備を含む） */
  readonly cars: number;
  /** 年間の車両キロ（両方向） */
  readonly carKmPerYear: number;
}

export function patternStops(p: ServicePattern, geo: LineGeometry): boolean[] {
  if (p.stopStationIds === null) return geo.stations.map(() => true);
  const set = new Set(p.stopStationIds);
  return geo.stations.map((s, i) => set.has(s.id) || i === 0 || i === geo.stations.length - 1);
}

/**
 * 停車駅間の所要時間 [分]。併用軌道を含む区間は、最高速度を併用軌道の制限にし、信号待ちなどの遅れを足し、
 * 平均速度が制限（軌道運転規則 第53条: 30 km/h）を超えないようにする（docs/design.md §15.2）。
 * @param from, to geo.stations の添字（from < to）
 */
export function stopToStopMinutes(geo: LineGeometry, from: number, to: number, t: TransitTypeParams): number {
  const dist = geo.chainageKm[to]! - geo.chainageKm[from]!;
  const arrivalTransfer = geo.stations[to]!.transferTo !== null;
  let streetKm = 0;
  for (let k = from; k < to; k++) if (geo.segments[k]?.structure === 'street') streetKm += geo.segments[k]!.lengthKm;
  if (!t.street || streetKm <= 0) return legMinutes(dist, t, arrivalTransfer);
  const run = legMinutes(dist, { ...t, maxSpeedKmh: t.street.maxSpeedKmh }, arrivalTransfer) + streetKm * t.street.signalDelayMinPerKm;
  // 併用軌道の部分の平均速度の上限（その部分にかかる時間が streetKm / 上限 を下回らない）
  return Math.max(run, (streetKm / t.street.maxAverageKmh) * 60);
}

/** 種別の停車駅ごとの所要時間（起点から）。駅間距離はキロ程の差 */
export function patternTimes(stops: readonly boolean[], geo: LineGeometry, t: TransitTypeParams): number[] {
  const cum = geo.stations.map(() => NaN);
  let prev = -1;
  let acc = 0;
  stops.forEach((s, i) => {
    if (!s) return;
    if (prev >= 0) acc += stopToStopMinutes(geo, prev, i, t);
    cum[i] = acc;
    prev = i;
  });
  return cum;
}

/** 選んだ交通機関タイプで選べない構造の区間（区間の起点駅 id） */
export function invalidStructureSegments(geo: LineGeometry, t: TransitTypeParams): string[] {
  return geo.segments.filter((s) => !t.structures.includes(s.structure)).map((s) => s.fromStationId);
}

/** 運行計画の警告: 最小運転間隔より短い（合計ピーク本数が多すぎる）、編成両数が上限を超える */
export function planWarnings(plan: ServicePlan, t: TransitTypeParams): string[] {
  const out: string[] = [];
  const total = plan.patterns.reduce((a, p) => a + p.tphPeak, 0);
  if (total > 60 / t.minHeadwayMin) out.push(`ピーク本数の合計 ${total} 本/時は、${t.name}の最小運転間隔 ${t.minHeadwayMin} 分（${Math.floor(60 / t.minHeadwayMin)} 本/時）を超えています`);
  for (const p of plan.patterns) {
    if (p.carsPerTrain > t.maxCarsPerTrain) out.push(`${p.name}の編成両数 ${p.carsPerTrain} 両は、${t.name}の上限 ${t.maxCarsPerTrain} 両を超えています`);
  }
  return out;
}

/**
 * 待避設備が必要な駅（簡易判定。docs/design.md §14.3）。
 * 速い種別 F と遅い種別 S の組ごとに、S は等間隔（運行間隔 h = 60 / S のピーク本数）で走り、F は前の S の h/2 後に
 * 発車すると仮定する。両方が停車する駅で測った「F が S より先に進んだ時間」（起点からの所要時間の差）が
 * h/2, 3h/2, 5h/2 … を超えるたびに F が S に追いつくので、超える手前の「両方が停車する駅」で S が F を待避する。
 * 上り・下りの両方向で判定し、起点（発車順で調整できる）は除く。
 */
export function passingStations(ops: readonly PatternOperation[]): number[] {
  const out = new Set<number>();
  const n = ops[0]?.stops.length ?? 0;
  for (const f of ops) {
    for (const s of ops) {
      if (f === s || !(s.pattern.tphPeak > 0) || !(f.oneWayMin < s.oneWayMin)) continue;
      const h = 60 / s.pattern.tphPeak;
      for (const forward of [true, false]) {
        const order = forward ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
        const both = order.filter((i) => s.stops[i] && f.stops[i]);
        const o = both[0]!;
        const gain = (i: number) => Math.abs(s.cumMin[i]! - s.cumMin[o]!) - Math.abs(f.cumMin[i]! - f.cumMin[o]!);
        const total = gain(both[both.length - 1]!);
        for (let thr = h / 2; thr < total; thr += h) {
          const before = both.filter((i) => gain(i) <= thr);
          const k = before[before.length - 1];
          if (k !== undefined && k !== o) out.add(k);
        }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function computeLinePlanOperation(
  geo: LineGeometry,
  plan: ServicePlan,
  t: TransitTypeParams,
  hours: OperatingHours,
  spareRatio: number,
): LinePlanOperation {
  const patterns: PatternOperation[] = plan.patterns.map((p) => {
    const stops = patternStops(p, geo);
    const cumMin = patternTimes(stops, geo, t);
    const oneWayMin = geo.stations.length >= 2 ? cumMin[cumMin.length - 1]! : 0;
    const cycleMin = oneWayMin * 2 + t.turnbackMin * 2;
    const trainsets = geo.stations.length >= 2 ? Math.ceil((p.tphPeak * cycleMin) / 60) : 0;
    return { pattern: p, stops, cumMin, oneWayMin, cycleMin, trainsets };
  });
  let trainsets = 0;
  let carsExact = 0;
  let carKm = 0;
  for (const op of patterns) {
    const p = op.pattern;
    trainsets += op.trainsets;
    carsExact += op.trainsets * p.carsPerTrain;
    const trainsPerDay = p.tphPeak * hours.peakHoursPerDay + p.tphOffpeak * Math.max(hours.operatingHoursPerDay - hours.peakHoursPerDay, 0);
    carKm += trainsPerDay * 2 * geo.totalKm * p.carsPerTrain * 365;
  }
  return {
    patterns,
    chainageKm: geo.chainageKm,
    passingStations: patterns.length >= 2 ? passingStations(patterns) : [],
    trainsets,
    cars: Math.ceil(carsExact * (1 + spareRatio)),
    carKmPerYear: carKm,
  };
}
