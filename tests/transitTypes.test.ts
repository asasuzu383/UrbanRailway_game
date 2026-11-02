import { describe, expect, it } from 'vitest';
import { defaultCostParams } from '../src/config/cost';
import { TRANSIT_TYPE_ORDER, TRANSIT_TYPES } from '../src/config/transitTypes';
import type { StructureType, UserLine } from '../src/core/types';
import { effectiveCostParams, estimateConstruction } from '../src/finance/finance';
import { computeLineGeometry } from '../src/network/lineGeometry';
import { legMinutes } from '../src/network/runtime';
import {
  computeLinePlanOperation,
  defaultServicePlan,
  invalidStructureSegments,
  planWarnings,
  stopToStopMinutes,
} from '../src/network/servicePlan';
import { validateScenario } from '../src/state/scenarioIO';

const OKU = 1e8;
const hours = { peakHoursPerDay: 4, operatingHoursPerDay: 18 };

/** 東西に約 1km 間隔の 3 駅。区間の構造を指定 */
function line(structures: [StructureType, StructureType], transitType?: UserLine['transitType']): UserLine {
  const v = (i: number) => ({ kind: 'station' as const, id: `s${i}`, position: [139.7 + i * 0.011, 35.7] as const, name: `S${i}`, transferTo: null });
  return {
    id: 'L', name: 'テスト', color: '#000', ...(transitType ? { transitType } : {}),
    vertices: [v(0), v(1), v(2)],
    segments: [{ fromStationId: 's0', structure: structures[0] }, { fromStationId: 's1', structure: structures[1] }],
  };
}

describe('交通機関タイプのパラメータ', () => {
  it('4 タイプがそろい、モノレール・AGT は高架のみ、LRT は併用軌道を選べる', () => {
    expect(TRANSIT_TYPE_ORDER).toEqual(['heavyRail', 'monorail', 'agt', 'lrt']);
    expect(TRANSIT_TYPES.monorail.structures).toEqual(['elevated']);
    expect(TRANSIT_TYPES.agt.structures).toEqual(['elevated']);
    expect(TRANSIT_TYPES.lrt.structures).toContain('street');
    expect(TRANSIT_TYPES.heavyRail.structures).not.toContain('street');
    for (const id of TRANSIT_TYPE_ORDER) {
      const t = TRANSIT_TYPES[id];
      expect(t.capacityPerCar).toBeGreaterThan(0);
      expect(t.minHeadwayMin).toBeGreaterThan(0);
    }
    // インフラ補助の対象になりうるのはモノレール・AGT（Phase 4 で使うフラグ）
    expect(TRANSIT_TYPE_ORDER.filter((id) => TRANSIT_TYPES[id].infraSubsidyEligible)).toEqual(['monorail', 'agt']);
  });

  it('選べない構造の区間を検出する', () => {
    const g = computeLineGeometry(line(['atGrade', 'elevated']));
    expect(invalidStructureSegments(g, TRANSIT_TYPES.monorail)).toEqual(['s0']);
    expect(invalidStructureSegments(g, TRANSIT_TYPES.heavyRail)).toEqual([]);
    const s = computeLineGeometry(line(['street', 'atGrade']));
    expect(invalidStructureSegments(s, TRANSIT_TYPES.heavyRail)).toEqual(['s0']);
    expect(invalidStructureSegments(s, TRANSIT_TYPES.lrt)).toEqual([]);
  });

  it('運行計画の警告: 最小運転間隔より短い・編成両数が上限を超える', () => {
    const l = line(['elevated', 'elevated']);
    const plan = defaultServicePlan(l, { tphPeak: 30, tphOffpeak: 10, carsPerTrain: 8 });
    const w = planWarnings(plan, TRANSIT_TYPES.agt); // 2.5 分間隔 = 24 本/時、上限 6 両
    expect(w).toHaveLength(2);
    expect(planWarnings(defaultServicePlan(l, { tphPeak: 20, tphOffpeak: 10, carsPerTrain: 6 }), TRANSIT_TYPES.agt)).toEqual([]);
  });
});

describe('所要時間（タイプ別・併用軌道）', () => {
  it('併用軌道は最高 40 km/h・信号待ちを加え、平均 30 km/h を超えない（軌道運転規則 第53条）', () => {
    const lrt = TRANSIT_TYPES.lrt;
    const street = computeLineGeometry(line(['street', 'street'], 'lrt'));
    const dedicated = computeLineGeometry(line(['atGrade', 'atGrade'], 'lrt'));
    const tStreet = stopToStopMinutes(street, 0, 2, lrt);
    const tDedicated = stopToStopMinutes(dedicated, 0, 2, lrt);
    const km = street.chainageKm[2]!;
    expect(tStreet).toBeGreaterThan(tDedicated);
    expect(tStreet).toBeGreaterThanOrEqual((km / 30) * 60 - 1e-9);
    // 専用軌道は通常の運転曲線
    expect(tDedicated).toBeCloseTo(legMinutes(km, lrt, false), 10);
  });

  it('駅間が長いと、最高速度の低い AGT（60 km/h）は普通鉄道（110 km/h）より遅い', () => {
    const l = line(['elevated', 'elevated']);
    // 駅間を約 5km に広げる
    const wide: UserLine = { ...l, vertices: l.vertices.map((v, i) => ({ ...v, position: [139.7 + i * 0.055, 35.7] as const })) };
    const g = computeLineGeometry(wide);
    const t = (id: 'heavyRail' | 'agt') =>
      computeLinePlanOperation(g, defaultServicePlan(wide, { tphPeak: 10, tphOffpeak: 6, carsPerTrain: 4 }), TRANSIT_TYPES[id], hours, 0.1).patterns[0]!.oneWayMin;
    expect(t('agt')).toBeGreaterThan(t('heavyRail'));
  });
});

describe('費用（タイプ別）', () => {
  it('普通鉄道はパラメータ画面の値のまま、他のタイプは単価・賃率を上書きする', () => {
    expect(effectiveCostParams(defaultCostParams, TRANSIT_TYPES.heavyRail)).toBe(defaultCostParams);
    const m = effectiveCostParams(defaultCostParams, TRANSIT_TYPES.monorail);
    expect(m.construction.trackPerKm.elevated).toBe(110 * OKU);
    expect(m.construction.carPrice).toBe(2.0 * OKU);
    expect(m.fare.minimumFare).toBe(200);
    expect(m.fare.commuterShare).toBe(defaultCostParams.fare.commuterShare); // 共通の値は残る
  });

  it('モノレールの建設費はモノレールの単価で計算される', () => {
    const l = line(['elevated', 'elevated'], 'monorail');
    const g = computeLineGeometry(l);
    const p = effectiveCostParams(defaultCostParams, TRANSIT_TYPES.monorail);
    const op = computeLinePlanOperation(g, defaultServicePlan(l, { tphPeak: 10, tphOffpeak: 6, carsPerTrain: 4 }), TRANSIT_TYPES.monorail, hours, 0.1);
    const c = estimateConstruction(g, p, op, null);
    expect(c.byStructure.elevated.trackCost).toBeCloseTo(g.totalKm * 110 * OKU, 0);
    expect(c.byStructure.elevated.stationCost).toBe(3 * 15 * OKU);
    expect(c.vehicles.cost).toBe(c.vehicles.cars * 2.0 * OKU);
  });
});

describe('費用（併用軌道）', () => {
  it('建設費の内訳はすべての構造を持ち、LRT の併用軌道は LRT の単価で計算される', () => {
    const l = line(['street', 'atGrade'], 'lrt');
    const g = computeLineGeometry(l);
    const p = effectiveCostParams(defaultCostParams, TRANSIT_TYPES.lrt);
    const op = computeLinePlanOperation(g, defaultServicePlan(l, { tphPeak: 8, tphOffpeak: 6, carsPerTrain: 3 }), TRANSIT_TYPES.lrt, hours, 0.1);
    const c = estimateConstruction(g, p, op, null);
    expect(Object.keys(c.byStructure).sort()).toEqual(['atGrade', 'elevated', 'street', 'underground']);
    expect(c.byStructure.street.trackCost).toBeCloseTo(g.segments[0]!.lengthKm * 25 * OKU, 0);
    expect(c.byStructure.atGrade.trackCost).toBeCloseTo(g.segments[1]!.lengthKm * 35 * OKU, 0);
  });
});

describe('シナリオの保存形式', () => {
  it('交通機関タイプと併用軌道を読み込み、不正なタイプは拒否する', () => {
    const ok = validateScenario({ schemaVersion: 1, lines: [line(['street', 'atGrade'], 'lrt')] });
    expect(ok.lines[0]!.transitType).toBe('lrt');
    expect(ok.lines[0]!.segments[0]!.structure).toBe('street');
    expect(validateScenario({ schemaVersion: 1, lines: [line(['atGrade', 'atGrade'])] }).lines[0]!.transitType).toBeUndefined();
    expect(() => validateScenario({ schemaVersion: 1, lines: [{ ...line(['atGrade', 'atGrade']), transitType: 'hyperloop' }] })).toThrow();
  });
});
