import { describe, expect, it } from 'vitest';
import { defaultDemandParams } from '../src/config/demand';
import { TRANSIT_TYPES } from '../src/config/transitTypes';
import type { ServicePlan, UserLine } from '../src/core/types';
import { describeQuality, rideTimesFrom, routesAtStation, SERVICE_QUALITY_LABEL, type ExistingRoute, type ServicesFile } from '../src/data/services';
import { runDemand } from '../src/demand/engine';
import { operationFromPlan } from '../src/demand/lineOperation';
import { computeLineGeometry } from '../src/network/lineGeometry';
import { legMinutes, runSeconds } from '../src/network/runtime';
import { computeLinePlanOperation, defaultServicePlan, normalizePlan, passingStations } from '../src/network/servicePlan';
import { makeLine, realContext } from './helpers/realData';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rail = TRANSIT_TYPES.heavyRail;
const hours = { peakHoursPerDay: 4, operatingHoursPerDay: 18 };

/** 東西に約 1.5km 間隔で並ぶ n 駅（最後の駅だけ既存駅に接続） */
function straightLine(n: number): UserLine {
  const vertices = Array.from({ length: n }, (_, i) => ({
    kind: 'station' as const,
    id: `s${i}`,
    position: [139.6 + i * 0.0166, 35.7] as const,
    name: `S${i}`,
    transferTo: i === n - 1 ? 'g1' : null,
  }));
  return { id: 'L', name: 'テスト', color: '#000', vertices, segments: vertices.slice(0, -1).map((v) => ({ fromStationId: v.id, structure: 'elevated' as const })) };
}

describe('運転曲線（駅間所要時間）', () => {
  it('短い駅間は最高速度に届かず三角形、長い駅間は台形', () => {
    // 500m: 最高速度 110km/h に届かない
    const tShort = runSeconds(0.5, 110, 3, 3.5);
    const v = Math.sqrt((2 * 500 * (3 / 3.6) * (3.5 / 3.6)) / (3 / 3.6 + 3.5 / 3.6));
    expect(tShort).toBeCloseTo(v / (3 / 3.6) + v / (3.5 / 3.6), 6);
    // 10km: ほぼ 10km ÷ 110km/h に加減速の損失（v/2a + v/2b）を足したもの
    const vmax = 110 / 3.6;
    expect(runSeconds(10, 110, 3, 3.5)).toBeCloseTo(10000 / vmax + vmax / (2 * (3 / 3.6)) + vmax / (2 * (3.5 / 3.6)), 6);
    expect(runSeconds(0, 110, 3, 3.5)).toBe(0);
  });

  it('駅間所要時間は（走行 + 停車）× 余裕係数。接続駅は停車時間が長い', () => {
    const run = runSeconds(1.5, rail.maxSpeedKmh, rail.accelKmhPerS, rail.decelKmhPerS);
    expect(legMinutes(1.5, rail, false)).toBeCloseTo(((run + 30) * 1.15) / 60, 10);
    expect(legMinutes(1.5, rail, true)).toBeCloseTo(((run + 50) * 1.15) / 60, 10);
  });
});

describe('運行計画', () => {
  const line = straightLine(9);
  const geo = computeLineGeometry(line);
  const local = { id: 'l', name: '各停', stopStationIds: null, tphPeak: 8, tphOffpeak: 6, carsPerTrain: 8 };
  const express = { id: 'e', name: '快速', stopStationIds: ['s0', 's4', 's8'], tphPeak: 4, tphOffpeak: 3, carsPerTrain: 8 };

  it('既定の計画は各停のみ。停車駅に起点・終点を補い、直通は端の接続駅だけ残す', () => {
    const d = { tphPeak: 12, tphOffpeak: 6, carsPerTrain: 6 };
    expect(normalizePlan(undefined, line, geo, d).patterns).toHaveLength(1);
    const plan: ServicePlan = {
      lineId: 'L',
      patterns: [{ ...express, stopStationIds: ['s4', 'xx'] }],
      through: [{ atStationId: 's8', routeId: 'r' }, { atStationId: 's0', routeId: 'r' }],
    };
    const n = normalizePlan(plan, line, geo, d);
    expect(n.patterns[0]!.stopStationIds).toEqual(['s0', 's4', 's8']);
    expect(n.through).toEqual([{ atStationId: 's8', routeId: 'r' }]); // s0 は接続駅でない
  });

  it('必要編成数 = ⌈ピーク本数 × 往復時間 / 60⌉、両数は予備込み、車両キロは時間帯別の本数から', () => {
    const op = computeLinePlanOperation(geo, defaultServicePlan(line, { tphPeak: 8, tphOffpeak: 6, carsPerTrain: 8 }), rail, hours, 0.1);
    const p = op.patterns[0]!;
    expect(p.cycleMin).toBeCloseTo(p.oneWayMin * 2 + 20, 10);
    expect(p.trainsets).toBe(Math.ceil((8 * p.cycleMin) / 60));
    expect(op.cars).toBe(Math.ceil(p.trainsets * 8 * 1.1));
    expect(op.carKmPerYear).toBeCloseTo((8 * 4 + 6 * 14) * 2 * geo.totalKm * 8 * 365, 3);
  });

  it('快速は各停より速く、通過運転があると途中駅に待避設備が要る', () => {
    const plan: ServicePlan = { lineId: 'L', patterns: [local, express], through: [] };
    const op = computeLinePlanOperation(geo, plan, rail, hours, 0.1);
    const [l, e] = op.patterns;
    expect(e!.oneWayMin).toBeLessThan(l!.oneWayMin);
    expect(op.passingStations.length).toBeGreaterThan(0);
    for (const i of op.passingStations) {
      expect(i).toBeGreaterThan(0);
      expect(i).toBeLessThan(8);
      expect(l!.stops[i] && e!.stops[i]).toBe(true); // 待避は両方が停車する駅
    }
    // 各停だけなら待避は要らない
    expect(passingStations([l!])).toEqual([]);
  });
});

describe('直通先の系統の乗車時間', () => {
  const route: ExistingRoute = {
    id: 'r', name: 'R', operator: 'X', quality: 'published', stations: [10, 11, 12, 13], cars: 10,
    services: [
      { name: '各停', stops: [0, 1, 2, 3], legMinutes: [2, 3, 4], tph: { peak: 10, offpeak: 6 } },
      { name: '急行', stops: [0, 3], legMinutes: [7], tph: { peak: 4, offpeak: 3 } },
    ],
  };

  it('本数の多い種別で、接続駅から両方向の各駅までの時間を積み上げる', () => {
    expect([...rideTimesFrom(route, 11).entries()]).toEqual([[12, 3], [13, 7], [10, 2]]);
    expect(rideTimesFrom(route, 99).size).toBe(0);
  });
});

describe('既存線のデータ品質', () => {
  it('項目ごとの品質を、該当しない項目を除いて説明する', () => {
    const text = describeQuality({ stops: 'published', runTime: 'estimated', maxSpeed: 'provisional', peak: 'published', offpeak: null });
    expect(text).toBe('所要時間 物理推定、停車駅 公表資料、最高速度 仮置き、ピーク本数 公表資料');
    expect(describeQuality(undefined)).toBe('');
  });

  it('services.json の品質フラグは 4 段階のどれか', () => {
    const file = JSON.parse(readFileSync(resolve(__dirname, '../public/data/shutoken/services.json'), 'utf8')) as ServicesFile;
    const flags = new Set(Object.keys(SERVICE_QUALITY_LABEL));
    for (const r of file.routes) {
      expect(flags.has(r.quality)).toBe(true);
      expect(r.qualityDetail?.runTime).toBe(r.quality);
    }
    expect(file.lineQualityDetail?.length).toBe(file.lineQuality.length);
  });
});

describe('運行計画と需要', () => {
  const { ctx } = realContext();
  const w = defaultDemandParams.generalizedCost;

  it('本数を増やすと需要が増える（待ち時間が減る）', () => {
    const line = makeLine(['練馬', [139.645, 35.715], '荻窪']);
    const geo = computeLineGeometry(line);
    const run = (tph: number) => {
      const plan = defaultServicePlan(line, { tphPeak: tph, tphOffpeak: tph, carsPerTrain: 8 });
      return runDemand(line, ctx, operationFromPlan(computeLinePlanOperation(geo, plan, rail, hours, 0.1), w)).dailyPassengers;
    };
    expect(run(15)).toBeGreaterThan(run(4));
  });

  it('既存の系統へ直通すると、接続駅の乗換がなくなり需要が増える', () => {
    const services = JSON.parse(readFileSync(resolve(__dirname, '../public/data/shutoken/services.json'), 'utf-8')) as ServicesFile;
    const line = makeLine([[139.66, 35.62], [139.68, 35.645], '渋谷']);
    const geo = computeLineGeometry(line);
    const shibuya = ctx.stations.byId.get(line.vertices[2]!.kind === 'station' ? line.vertices[2]!.transferTo! : '')!;
    const route = routesAtStation(services, shibuya).sort((a, b) => b.stations.length - a.stations.length)[0]!;
    const op = computeLinePlanOperation(geo, defaultServicePlan(line, { tphPeak: 12, tphOffpeak: 6, carsPerTrain: 8 }), rail, hours, 0.1);
    const without = runDemand(line, ctx, operationFromPlan(op, w)).dailyPassengers;
    const withThrough = runDemand(line, ctx, operationFromPlan(op, w, [{ stop: 2, ivtTo: rideTimesFrom(route, shibuya) }])).dailyPassengers;
    expect(withThrough).toBeGreaterThan(without);
  });
});
