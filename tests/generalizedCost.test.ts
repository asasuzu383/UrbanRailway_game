import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDemandParams, type DemandParams } from '../src/config/demand';
import {
  addCosts,
  generalizedMinutes,
  representativeTph,
  rideCost,
  waitMinutes,
  ZERO_COST,
  type GeneralizedCostWeights,
} from '../src/core/generalizedCost';
import type { StationsFile, ZonesFile } from '../src/data/schema';
import { TimeMatrix } from '../src/data/timeMatrix';
import { createDemandContext } from '../src/demand/context';
import { runDemand } from '../src/demand/engine';
import { makeLine } from './helpers/realData';

const w: GeneralizedCostWeights = { waitWeight: 1.5, maxWaitMin: 15, peakShare: 0.5, walkWeight: 1.0 };

describe('一般化費用', () => {
  it('待ち時間は運行間隔の半分で、上限がある', () => {
    expect(waitMinutes(12, w)).toBeCloseTo(2.5);
    expect(waitMinutes(2, w)).toBe(15); // 30 分間隔 → 15 分（上限ちょうど）
    expect(waitMinutes(1, w)).toBe(15); // 60 分間隔でも上限 15 分
    expect(waitMinutes(0, w)).toBe(15);
  });

  it('代表本数はピークと日中の加重平均', () => {
    expect(representativeTph({ peak: 20, offpeak: 10 }, w)).toBe(15);
    expect(representativeTph({ peak: 20, offpeak: 10 }, { ...w, peakShare: 1 })).toBe(20);
  });

  it('内訳から一般化費用を合成する（待ちと徒歩に重み）', () => {
    const c = { inVehicleMin: 20, waitMin: 4, transferMin: 8, accessMin: 5, walkMin: 2 };
    expect(generalizedMinutes(c, w)).toBeCloseTo(20 + 1.5 * 4 + 8 + 5 + 2);
    expect(generalizedMinutes(c, { ...w, accessWeight: 2 })).toBeCloseTo(20 + 6 + 8 + 10 + 2);
  });

  it('直通運転は乗換抵抗・待ち時間とも 0、乗換は両方かかる', () => {
    const through = rideCost(10, 6, 8, true, w);
    expect(through).toEqual({ ...ZERO_COST, inVehicleMin: 10 });
    const transfer = rideCost(10, 6, 8, false, w);
    expect(transfer.waitMin).toBeCloseTo(5);
    expect(transfer.transferMin).toBe(8);
    expect(generalizedMinutes(addCosts(through, transfer), w)).toBeCloseTo(10 + 10 + 1.5 * 5 + 8);
  });
});

describe('一般化費用と新線の需要', () => {
  const DATA = resolve(__dirname, '../public/data/shutoken');
  const zones = JSON.parse(readFileSync(resolve(DATA, 'zones.json'), 'utf-8')) as ZonesFile;
  const stations = JSON.parse(readFileSync(resolve(DATA, 'stations.json'), 'utf-8')) as StationsFile;
  const times = new TimeMatrix(stations.stations.length, new Uint8Array(readFileSync(resolve(DATA, 'times.bin'))));
  const ctxWith = (tph: number) => {
    const params: DemandParams = { ...defaultDemandParams, service: { ...defaultDemandParams.service, representativeTph: tph } };
    return createDemandContext(zones, stations.stations, times, params);
  };

  it('新線の本数が増えると待ち時間が減り、需要が増える', () => {
    const line = makeLine(['練馬', [139.645, 35.715], '荻窪']);
    const low = runDemand(line, ctxWith(3)).dailyPassengers;
    const high = runDemand(line, ctxWith(15)).dailyPassengers;
    expect(high).toBeGreaterThan(low);
  });
});
