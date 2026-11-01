import { describe, expect, it } from 'vitest';
import { defaultDemandParams } from '../src/config/demand';
import { encodeUpperTriangle, TimeMatrix } from '../src/data/timeMatrix';
import { assignToLine } from '../src/demand/assignment';
import { createDemandContext } from '../src/demand/context';
import { tripEnds } from '../src/demand/engine';
import type { LineStop } from '../src/demand/lineStops';

const stop = (i: number, km: number): LineStop => ({ vertexId: `s${i}`, name: `S${i}`, position: [139.7, 35.7], chainageKm: km, existing: null });

describe('assignToLine', () => {
  it('OD を区間に積み上げ、人キロを数える', () => {
    const stops = [stop(0, 0), stop(1, 1), stop(2, 3)];
    const od = new Float64Array(9);
    od[0 * 3 + 2] = 100; // 0→2（2区間）
    od[1 * 3 + 2] = 50; // 1→2
    od[2 * 3 + 0] = 30; // 2→0（上り）
    const r = assignToLine(stops, od);
    expect(r.segments.map((s) => s.forward)).toEqual([100, 150]);
    expect(r.segments.map((s) => s.backward)).toEqual([30, 30]);
    expect(r.dailyPassengers).toBe(180);
    expect(r.dailyPassengerKm).toBe(100 * 3 + 50 * 2 + 30 * 3);
  });
});

describe('TimeMatrix', () => {
  it('上三角の符号化と復号が一致し、到達不能は Infinity', () => {
    const t = [
      [0, 5, Infinity],
      [5, 0, 12.4],
      [Infinity, 12.4, 0],
    ];
    const m = new TimeMatrix(3, encodeUpperTriangle(t));
    expect(m.get(0, 1)).toBe(5);
    expect(m.get(2, 1)).toBe(12);
    expect(m.get(0, 2)).toBe(Infinity);
    expect(m.get(1, 1)).toBe(0);
  });
});

describe('tripEnds', () => {
  const ctx = createDemandContext({ code: [], pop: [], emp: [] }, [], new TimeMatrix(0, new Uint8Array(0)), defaultDemandParams);

  it('駅勢圏・ACC が大きいほど増え、どちらかが 0 なら 0', () => {
    expect(tripEnds(ctx, 20000, 5e6)).toBeGreaterThan(tripEnds(ctx, 10000, 5e6));
    expect(tripEnds(ctx, 20000, 5e6)).toBeGreaterThan(tripEnds(ctx, 20000, 1e6));
    expect(tripEnds(ctx, 0, 5e6)).toBe(0);
    expect(tripEnds(ctx, 20000, 0)).toBe(0);
  });
});
