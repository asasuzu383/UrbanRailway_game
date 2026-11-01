/**
 * 需要推計エンジンの挙動テスト（public/data の実データを使用）。
 * 数値そのものではなく、モデルとして守るべき性質（単調性・保存則・過大推計の防止）を確かめる。
 */
import { describe, expect, it } from 'vitest';
import type { LngLat } from '../src/core/types';
import { runDemand } from '../src/demand/engine';
import { makeLine, realContext } from './helpers/realData';

const P1: LngLat = [139.635, 35.722];
const P2: LngLat = [139.625, 35.712];

describe('需要推計（実データ）', () => {
  const { ctx } = realContext();

  it('1 回の計算は 1 秒以内', () => {
    const t = performance.now();
    runDemand(makeLine(['赤羽', [139.69, 35.765], '中野', [139.665, 35.66], '大井町']), ctx);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('駅別乗降の合計は輸送人員の 2 倍（乗車と降車）', () => {
    const r = runDemand(makeLine(['練馬', P1, P2, '荻窪']), ctx);
    const sum = r.stations.reduce((a, s) => a + s.ridership, 0);
    expect(sum).toBeCloseTo(2 * r.dailyPassengers, 0);
    const byType = r.tripsByType.local + r.tripsByType.toExisting + r.tripsByType.through;
    expect(byType).toBeCloseTo(r.dailyPassengers, 0);
  });

  it('OD は対称で、上下の断面輸送量は等しい', () => {
    const r = runDemand(makeLine(['練馬', P1, P2, '荻窪']), ctx);
    for (const s of r.segments) expect(s.forward).toBeCloseTo(s.backward, 6);
  });

  it('既存線に接続しない路線は、同じ駅で接続した路線よりずっと少ない', () => {
    const connected = runDemand(makeLine(['練馬', P1, P2, '荻窪']), ctx);
    const isolated = runDemand(makeLine([P1, P2]), ctx);
    expect(isolated.dailyPassengers).toBeLessThan(connected.dailyPassengers * 0.05);
  });

  it('既存駅のすぐ横の新駅は、鉄道利用者をほとんど増やさない（取り合いになるだけ）', () => {
    // 荻窪駅から約 300m の位置（スナップしない）
    const next = runDemand(makeLine(['練馬', P1, [139.6235, 35.7065]]), ctx);
    const pop = next.stations[2]!.catchmentPopulation!;
    expect(pop).toBeGreaterThan(0);
    expect(next.newRailUsersPopulation).toBeLessThan(pop * 0.05);
  });

  it('駅の空白地帯の新駅は、既存駅の横より多くの新規利用者を生む', () => {
    // 練馬区西部（西武池袋線と新宿線の間）の駅空白地帯
    const gap = runDemand(makeLine(['練馬', [139.62, 35.745], [139.6, 35.745]]), ctx);
    const next = runDemand(makeLine(['練馬', P1, [139.6235, 35.7065]]), ctx);
    expect(gap.newRailUsersPopulation).toBeGreaterThan(next.newRailUsersPopulation);
  });

  it('駅が 1 つ以下なら結果は空', () => {
    const r = runDemand(makeLine(['練馬']), ctx);
    expect(r.dailyPassengers).toBe(0);
    expect(r.stations).toHaveLength(0);
  });
});
