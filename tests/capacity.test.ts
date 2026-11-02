import { describe, expect, it } from 'vitest';
import { defaultCapacityParams as c } from '../src/config/capacity';
import { defaultDemandParams } from '../src/config/demand';
import { TRANSIT_TYPES } from '../src/config/transitTypes';
import type { DemandResult } from '../src/core/types';
import { congestionRates, crowdingMultiplier, runDemandWithCapacity, segmentCapacity } from '../src/demand/capacity';
import { runDemand } from '../src/demand/engine';
import { operationFromPlan } from '../src/demand/lineOperation';
import { computeLineGeometry } from '../src/network/lineGeometry';
import { computeLinePlanOperation, defaultServicePlan } from '../src/network/servicePlan';
import { makeLine, realContext } from './helpers/realData';

describe('混雑率', () => {
  it('輸送力 = Σ ピーク本数 × 両数 × 1 両の定員（全区間）', () => {
    expect(segmentCapacity(3, [{ tphPeak: 10, carsPerTrain: 8 }, { tphPeak: 4, carsPerTrain: 10 }], 150)).toEqual([18000, 18000, 18000]);
  });

  it('混雑率 = 上下の大きい方の断面輸送量 × ピーク率 / 輸送力', () => {
    const demand = {
      segments: [
        { fromStationId: 'a', toStationId: 'b', lengthKm: 1, forward: 100_000, backward: 80_000 },
        { fromStationId: 'b', toStationId: 'c', lengthKm: 1, forward: 0, backward: 0 },
      ],
    } as unknown as DemandResult;
    const r = congestionRates(demand, [10_000, 10_000], c);
    expect(r[0]).toBeCloseTo((100_000 * c.peakHourShare) / 10_000, 10);
    expect(r[1]).toBe(0);
  });

  it('混雑の不効用: 100% 以下は係数 1、150% で 1.25 倍、200% で 1.5 倍', () => {
    expect(crowdingMultiplier(0.8, c)).toBe(1);
    expect(crowdingMultiplier(1.5, c)).toBeCloseTo(1.25, 10);
    expect(crowdingMultiplier(2.0, c)).toBeCloseTo(1.5, 10);
  });
});

describe('需要と混雑の均衡計算', () => {
  const { ctx } = realContext();
  const w = defaultDemandParams.generalizedCost;
  const line = makeLine(['練馬', [139.645, 35.715], '荻窪']);
  const geo = computeLineGeometry(line);
  const hours = { peakHoursPerDay: 4, operatingHoursPerDay: 18 };
  const opOf = (tph: number, cars: number) => {
    const plan = defaultServicePlan(line, { tphPeak: tph, tphOffpeak: tph / 2, carsPerTrain: cars });
    return { plan, op: operationFromPlan(computeLinePlanOperation(geo, plan, TRANSIT_TYPES.agt, hours, 0.1), w) };
  };

  it('輸送力が十分なら係数 1 のまま 1 回で終わり、制約なしの推計と同じ', () => {
    const { plan, op } = opOf(20, 6);
    const cap = segmentCapacity(geo.segments.length, plan.patterns, 100_000); // 非常に大きい定員
    const r = runDemandWithCapacity(line, ctx, op, cap, c);
    expect(r.iterations).toBe(1);
    expect(r.multipliers.every((m) => m === 1)).toBe(true);
    expect(r.demand.dailyPassengers).toBeCloseTo(runDemand(line, ctx, op).dailyPassengers, 6);
  });

  it('輸送力が小さいと混雑の不効用で需要が減り、混雑率も下がって収束する', () => {
    const { plan, op } = opOf(4, 2); // AGT 2 両 × 4 本/時 = 400 人/時
    const cap = segmentCapacity(geo.segments.length, plan.patterns, TRANSIT_TYPES.agt.capacityPerCar);
    const free = runDemand(line, ctx, op);
    const freeRates = congestionRates(free, cap, c);
    expect(Math.max(...freeRates)).toBeGreaterThan(1);
    const r = runDemandWithCapacity(line, ctx, op, cap, c);
    expect(r.iterations).toBeGreaterThan(1);
    expect(r.demand.dailyPassengers).toBeLessThan(free.dailyPassengers);
    expect(Math.max(...r.congestion)).toBeLessThan(Math.max(...freeRates));
    expect(r.multipliers.some((m) => m > 1)).toBe(true);
  });
});
