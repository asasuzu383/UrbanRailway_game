/**
 * 建設費・収入・運行経費・回収年数（docs/design.md §6）。すべて純粋関数。
 */
import type { TransitTypeParams } from '../config/transitTypes';
import type { LinePlanOperation } from '../network/servicePlan';
import type { CostParams } from '../config/cost';
import { distanceKm } from '../core/geo';
import type {
  AnnualFinance,
  ConstructionCostBreakdown,
  DemandResult,
  FinanceResult,
  LngLat,
  OperatingCostBreakdown,
  StructureCost,
  StructureType,
} from '../core/types';
import type { LineGeometry } from '../network/lineGeometry';
import type { LandPriceIndex } from './landPrice';

const STRUCTURES: readonly StructureType[] = ['street', 'atGrade', 'elevated', 'underground'];
const RANK: Record<StructureType, number> = { street: 0, atGrade: 1, elevated: 2, underground: 3 };
/** 用地費を求めるときの区間の標本間隔 [km] */
const LAND_SAMPLE_KM = 0.1;

/** 駅の構造 = 隣接する区間のうち最も高価な構造（地下 > 高架 > 地平） */
export function stationStructures(geo: LineGeometry): StructureType[] {
  return geo.stations.map((_, i) => {
    const adj = [geo.segments[i - 1]?.structure, geo.segments[i]?.structure].filter((x): x is StructureType => !!x);
    return adj.reduce<StructureType>((a, b) => (RANK[b] > RANK[a] ? b : a), adj[0] ?? 'atGrade');
  });
}

/**
 * 交通機関タイプの費用・運賃を反映した費用パラメータ（docs/design.md §15）。普通鉄道は p のまま（パラメータ画面の値）。
 * 他のタイプは建設・車両・運行経費の単価と賃率・最低運賃をタイプの値で上書きする（用地の地価補正・管理費率・定期の割合などは共通）。
 */
export function effectiveCostParams(p: CostParams, t: TransitTypeParams): CostParams {
  const o = t.costs;
  if (!o) return p;
  return {
    ...p,
    construction: {
      ...p.construction,
      trackPerKm: { ...p.construction.trackPerKm, ...o.trackPerKm },
      stationEach: { ...p.construction.stationEach, ...o.stationEach },
      passingLoopEach: { ...p.construction.passingLoopEach, ...o.passingLoopEach },
      carPrice: o.carPrice,
    },
    land: { ...p.land, widthM: { ...p.land.widthM, ...o.landWidthM } },
    operating: {
      ...p.operating,
      perCarKm: o.perCarKm,
      trackMaintenancePerKmYear: { ...p.operating.trackMaintenancePerKmYear, ...o.trackMaintenancePerKmYear },
      stationPerYear: { ...p.operating.stationPerYear, ...o.stationPerYear },
    },
    fare: { ...p.fare, nonCommuterRatePerKm: o.fareBaseRatePerKm, minimumFare: o.fareMinimum },
  };
}

/**
 * 建設費。車両費は運行計画の必要編成数（ピーク本数 × 往復時間、種別ごと）に予備を加えた両数、
 * 待避設備は通過運転のある種別があるときに必要な駅（network/servicePlan.ts）の分を加える。
 */
export function estimateConstruction(
  geo: LineGeometry,
  p: CostParams,
  op: LinePlanOperation,
  landPrice: LandPriceIndex | null,
): ConstructionCostBreakdown {
  const c = p.construction;
  const by = Object.fromEntries(
    STRUCTURES.map((s) => [s, { lengthKm: 0, trackCost: 0, stationCount: 0, stationCost: 0, landCost: 0 }]),
  ) as Record<StructureType, { -readonly [K in keyof StructureCost]: StructureCost[K] }>;
  let landMissing = false;

  const priceAt = (pos: LngLat): number => {
    const v = landPrice?.at(pos) ?? null;
    if (v === null) landMissing = true;
    return (v ?? 0) * p.land.priceFactor;
  };

  for (const seg of geo.segments) {
    const b = by[seg.structure];
    b.lengthKm += seg.lengthKm;
    b.trackCost += seg.lengthKm * c.trackPerKm[seg.structure];
    const width = p.land.widthM[seg.structure];
    if (width > 0) {
      for (const [pos, km] of samplePolyline(seg.coordinates, LAND_SAMPLE_KM)) {
        b.landCost += priceAt(pos) * width * km * 1000;
      }
    }
  }

  stationStructures(geo).forEach((s, i) => {
    const st = geo.stations[i]!;
    const b = by[s];
    b.stationCount += 1;
    b.stationCost += c.stationEach[s] * (st.transferTo ? c.transferStationFactor : 1);
    if (p.land.widthM[s] > 0 && !st.transferTo) b.landCost += priceAt(st.position) * p.land.stationAreaM2;
  });

  const empty = geo.segments.length === 0;
  const vehicles = { cars: empty ? 0 : op.cars, trainsets: empty ? 0 : op.trainsets, cost: (empty ? 0 : op.cars) * c.carPrice };
  const structures = stationStructures(geo);
  const passingStations = empty ? [] : op.passingStations;
  const passing = { stations: passingStations, cost: passingStations.reduce((a, i) => a + c.passingLoopEach[structures[i]!], 0) };

  let total = vehicles.cost + passing.cost;
  for (const s of STRUCTURES) total += by[s].trackCost + by[s].stationCost + by[s].landCost;
  return { byStructure: by, vehicles, passing, landPriceMissing: landMissing && !!landPrice, total };
}

/** 折れ線を間隔 stepKm で区切り、各区間の中点と長さを返す */
function samplePolyline(coords: readonly LngLat[], stepKm: number): [LngLat, number][] {
  const out: [LngLat, number][] = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const len = distanceKm(a, b);
    const n = Math.max(1, Math.ceil(len / stepKm));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push([[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], len / n]);
    }
  }
  return out;
}

/** 定期・定期外を合わせた平均賃率の係数（定期外賃率に対する比） */
export function blendFactor(p: CostParams): number {
  return 1 - p.fare.commuterShare * p.fare.commuterDiscount;
}

/**
 * 1 日の運賃収入 [円]。トリップごとに max(賃率 × 乗車キロ, 最低運賃) を取る。
 * 定期・定期外の平均として、賃率と最低運賃の両方に blendFactor を掛ける。
 */
export function dailyRevenue(demand: DemandResult, geo: LineGeometry, p: CostParams): number {
  const blend = blendFactor(p);
  const rate = p.fare.nonCommuterRatePerKm * blend;
  const minFare = p.fare.minimumFare * blend;
  const chainage = new Map(geo.stations.map((s, i) => [s.id, geo.chainageKm[i]!]));
  let sum = 0;
  for (const [from, row] of demand.od) {
    for (const [to, trips] of row) {
      const km = Math.abs((chainage.get(to) ?? 0) - (chainage.get(from) ?? 0));
      sum += trips * Math.max(rate * km, minFare);
    }
  }
  return sum;
}

/** 運行経費。車両キロは運行計画の種別ごとの（ピーク本数 × ピーク時間 + 日中本数 × 残りの運行時間）× 両方向 × 営業キロ × 両数 */
export function estimateOperatingCost(geo: LineGeometry, p: CostParams, op: LinePlanOperation): OperatingCostBreakdown {
  const o = p.operating;
  const carKm = op.carKmPerYear;
  const train = carKm * o.perCarKm;
  let track = 0;
  for (const seg of geo.segments) track += seg.lengthKm * o.trackMaintenancePerKmYear[seg.structure];
  let stations = 0;
  for (const s of stationStructures(geo)) stations += o.stationPerYear[s];
  const direct = train + track + stations;
  const overhead = direct * o.overheadRatio;
  return { train, track, stations, overhead, total: direct + overhead, carKm };
}

/** 年平均日の値から平日・休日 1 日あたりの値を求める（年間合計が一致するように按分） */
export function weekdayHoliday(dailyAverage: number, p: CostParams): { weekday: number; holiday: number } {
  const a = p.annual;
  const weekday = (dailyAverage * (a.weekdays + a.holidays)) / (a.weekdays + a.holidays * a.holidayFactor);
  return { weekday, holiday: weekday * a.holidayFactor };
}

/**
 * 年次のキャッシュフロー。建設費を開業時点（0 年目）に一括計上し、1 年目から営業収支（減価償却前）を積み上げる。
 * 需要の立ち上がりは収入にのみ掛ける（運行本数は開業時から定常値）。
 */
export function buildTimeline(construction: number, steadyRevenue: number, opex: number, p: CostParams): {
  timeline: AnnualFinance[];
  simplePaybackYears: number | null;
  discountedPaybackYears: number | null;
} {
  const ev = p.evaluation;
  const r = ev.discountRate;
  const timeline: AnnualFinance[] = [{
    year: 0, demandFactor: 0, revenue: 0, operatingCost: 0, operatingBalance: 0,
    cumulativeCashFlow: -construction, cumulativeDiscountedCashFlow: -construction,
  }];
  let cum = -construction;
  let cumDisc = -construction;
  let discounted: number | null = null;
  for (let y = 1; y <= ev.maxYears; y++) {
    const factor = ev.rampUp[Math.min(y - 1, ev.rampUp.length - 1)] ?? 1;
    const revenue = steadyRevenue * factor;
    const balance = revenue - opex;
    const prevDisc = cumDisc;
    cum += balance;
    cumDisc += balance / (1 + r) ** y;
    timeline.push({ year: y, demandFactor: factor, revenue, operatingCost: opex, operatingBalance: balance, cumulativeCashFlow: cum, cumulativeDiscountedCashFlow: cumDisc });
    if (discounted === null && prevDisc < 0 && cumDisc >= 0) {
      // 年の途中で回収した時点を線形補間
      discounted = y - 1 + -prevDisc / (cumDisc - prevDisc);
    }
  }
  const steadyBalance = steadyRevenue - opex;
  const simple = steadyBalance > 0 ? construction / steadyBalance : null;
  return {
    timeline,
    simplePaybackYears: simple !== null && simple <= ev.maxYears ? simple : null,
    discountedPaybackYears: steadyBalance > 0 ? discounted : null,
  };
}

export function runFinance(
  geo: LineGeometry,
  demand: DemandResult,
  p: CostParams,
  op: LinePlanOperation,
  landPrice: LandPriceIndex | null,
): FinanceResult {
  const construction = estimateConstruction(geo, p, op, landPrice);
  const steadyRevenue = dailyRevenue(demand, geo, p) * 365;
  const opex = estimateOperatingCost(geo, p, op);
  const { timeline, simplePaybackYears, discountedPaybackYears } = buildTimeline(construction.total, steadyRevenue, opex.total, p);
  const wh = weekdayHoliday(demand.dailyPassengers, p);
  const balance = steadyRevenue - opex.total;
  return {
    construction,
    steadyRevenue,
    steadyOperatingCost: opex,
    steadyOperatingBalance: balance,
    weekdayPassengers: wh.weekday,
    holidayPassengers: wh.holiday,
    averageFare: demand.dailyPassengers > 0 ? steadyRevenue / 365 / demand.dailyPassengers : 0,
    isProfitable: balance > 0,
    simplePaybackYears,
    discountedPaybackYears,
    timeline,
  };
}
