import { describe, expect, it } from 'vitest';
import { defaultCostParams, type CostParams } from '../src/config/cost';
import type { DemandResult, UserLine } from '../src/core/types';
import {
  blendFactor,
  buildTimeline,
  dailyRevenue,
  estimateConstruction,
  estimateOperatingCost,
  runFinance,
  stationStructures,
  weekdayHoliday,
} from '../src/finance/finance';
import { LandPriceIndex } from '../src/finance/landPrice';
import { TRANSIT_TYPES } from '../src/config/transitTypes';
import { computeLineGeometry } from '../src/network/lineGeometry';
import { computeLinePlanOperation, defaultServicePlan } from '../src/network/servicePlan';

const OKU = 1e8;
// 東西に 0.011 度（約1km）ずつ並ぶ 3 駅。A-B 地下、B-C 高架。C は既存駅に接続
const line: UserLine = {
  id: 'L', name: 'テスト', color: '#000',
  vertices: [
    { kind: 'station', id: 'a', position: [139.700, 35.7], name: 'A', transferTo: null },
    { kind: 'station', id: 'b', position: [139.711, 35.7], name: 'B', transferTo: null },
    { kind: 'station', id: 'c', position: [139.722, 35.7], name: 'C', transferTo: 'g1' },
  ],
  segments: [
    { fromStationId: 'a', structure: 'underground' },
    { fromStationId: 'b', structure: 'elevated' },
  ],
};
const geo = computeLineGeometry(line);
const p: CostParams = defaultCostParams;
const plan = defaultServicePlan(line, { tphPeak: 12, tphOffpeak: 6, carsPerTrain: 6 });
const op = computeLinePlanOperation(geo, plan, TRANSIT_TYPES.heavyRail, p.service, p.construction.spareRatio);

describe('建設費', () => {
  it('駅の構造は隣接区間のうち高価な方', () => {
    expect(stationStructures(geo)).toEqual(['underground', 'underground', 'elevated']);
  });

  it('構造別 km 単価 × 延長 ＋ 駅単価（接続駅は係数）＋ 車両費', () => {
    const c = estimateConstruction(geo, p, op, null);
    const km = geo.segments[0]!.lengthKm;
    expect(c.byStructure.underground.trackCost).toBeCloseTo(km * 300 * OKU, 0);
    expect(c.byStructure.underground.stationCount).toBe(2);
    expect(c.byStructure.underground.stationCost).toBe(2 * 200 * OKU);
    expect(c.byStructure.elevated.stationCost).toBe(40 * OKU * 0.7);
    // 地価データなしなら用地費 0
    expect(c.byStructure.elevated.landCost).toBe(0);
    // 約1km × 2 区間を普通鉄道の運転曲線で 片道 約4分 → 往復 約8分 + 折返し 20分 = 約28分、ピーク 12本/h → 6 編成、6 両 × 1.1 → 40 両
    expect(c.vehicles.trainsets).toBe(6);
    expect(c.vehicles.cars).toBe(40);
    expect(c.passing.stations).toEqual([]); // 各停のみなら待避設備なし
    const sum = Object.values(c.byStructure).reduce((a, s) => a + s.trackCost + s.stationCost + s.landCost, 0) + c.vehicles.cost;
    expect(c.total).toBeCloseTo(sum, 0);
  });

  it('用地費は地平・高架のみ（地価 × 幅 × 延長）、地下は 0', () => {
    const lp = new LandPriceIndex({ year: 2026, points: [[139.71, 35.7, 1_000_000, '000']] });
    const c = estimateConstruction(geo, p, op, lp);
    expect(c.byStructure.underground.landCost).toBe(0);
    // 高架 約1km × 幅 10m × 100万円/m²（接続駅なので駅用地は加えない）
    expect(c.byStructure.elevated.landCost).toBeCloseTo(geo.segments[1]!.lengthKm * 1000 * 10 * 1_000_000, -6);
  });
});

describe('収入・経費', () => {
  const demand: DemandResult = {
    stations: [], segments: [], dailyPassengers: 300, dailyPassengerKm: 0, newRailUsersPopulation: 0,
    tripsByType: { local: 300, toExisting: 0, through: 0 },
    od: new Map([
      ['a', new Map([['c', 100]])], // 約2km
      ['b', new Map([['c', 200]])], // 約1km
    ]),
  };

  it('運賃は max(賃率 × キロ, 最低運賃) を定期・定期外の平均で計算', () => {
    const blend = blendFactor(p);
    const km1 = geo.chainageKm[2]! - geo.chainageKm[0]!;
    const expected = 100 * Math.max(18 * blend * km1, 150 * blend) + 200 * Math.max(18 * blend * 1, 150 * blend);
    expect(dailyRevenue(demand, geo, p)).toBeCloseTo(expected, -1);
    expect(blend).toBeCloseTo(1 - 0.6 * 0.57, 10);
  });

  it('経費は車両キロ・線路保守・駅・管理費の合計', () => {
    const o = estimateOperatingCost(geo, p, op);
    // 1 日の片道本数 = ピーク 12 本 × 4 時間 + 日中 6 本 × 14 時間 = 132 本
    expect(o.carKm).toBeCloseTo(132 * 2 * geo.totalKm * 6 * 365, 3);
    expect(o.overhead).toBeCloseTo((o.train + o.track + o.stations) * 0.35, 0);
    expect(o.total).toBeCloseTo(o.train + o.track + o.stations + o.overhead, 0);
  });

  it('平日・休日の換算は年間合計を保つ', () => {
    const { weekday, holiday } = weekdayHoliday(1000, p);
    expect(weekday * 245 + holiday * 120).toBeCloseTo(1000 * 365, 6);
    expect(holiday / weekday).toBeCloseTo(0.7, 10);
  });
});

describe('回収年数', () => {
  const flat: CostParams = { ...p, evaluation: { ...p.evaluation, rampUp: [1], discountRate: 0.04 } };

  it('単純回収年数 = 建設費 / 営業収支、割引回収年数はそれより長い', () => {
    const r = buildTimeline(1000, 150, 50, flat);
    expect(r.simplePaybackYears).toBeCloseTo(10, 10);
    // 年 100 を 4% で割り引いて 1000 に届くのは 13.0 年目付近
    expect(r.discountedPaybackYears!).toBeGreaterThan(12.9);
    expect(r.discountedPaybackYears!).toBeLessThan(13.1);
    expect(r.timeline[0]!.cumulativeCashFlow).toBe(-1000);
  });

  it('営業収支が赤字なら回収不能（null）', () => {
    const r = buildTimeline(1000, 50, 80, flat);
    expect(r.simplePaybackYears).toBeNull();
    expect(r.discountedPaybackYears).toBeNull();
  });

  it('割引後に評価期間内で届かなければ割引回収年数は null', () => {
    // 年 10 の黒字、割引率 4% の永久年金の現在価値 250 < 建設費 1000
    const r = buildTimeline(1000, 20, 10, flat);
    expect(r.simplePaybackYears).toBeCloseTo(100, 6);
    expect(r.discountedPaybackYears).toBeNull();
  });

  it('立ち上がり期間は収入に需要係数を掛ける', () => {
    const r = buildTimeline(1000, 100, 0, p);
    expect(r.timeline[1]!.revenue).toBeCloseTo(70, 10);
    expect(r.timeline[6]!.revenue).toBeCloseTo(100, 10);
  });

  it('runFinance が全体を組み立てる', () => {
    const demand: DemandResult = {
      stations: [], segments: [], dailyPassengers: 50_000, dailyPassengerKm: 100_000, newRailUsersPopulation: 0,
      tripsByType: { local: 50_000, toExisting: 0, through: 0 },
      od: new Map([['a', new Map([['c', 25_000]])], ['c', new Map([['a', 25_000]])]]),
    };
    const f = runFinance(geo, demand, p, op, null);
    expect(f.steadyOperatingBalance).toBeCloseTo(f.steadyRevenue - f.steadyOperatingCost.total, 0);
    expect(f.isProfitable).toBe(f.steadyOperatingBalance > 0);
    expect(f.averageFare).toBeGreaterThan(0);
  });
});
