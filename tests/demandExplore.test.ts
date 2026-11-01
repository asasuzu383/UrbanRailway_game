import { it } from 'vitest';
import { runDemand } from '../src/demand/engine';
import { makeLine, realContext } from './helpers/realData';

// 探索用（数値を眺めるだけ。アサーションは demand.real.test.ts に置く）
it.skipIf(!process.env.EXPLORE)('explore', () => {
  const t0 = performance.now();
  const { ctx } = realContext();
  console.log('context', Math.round(performance.now() - t0), 'ms');
  const cases: Record<string, ReturnType<typeof makeLine>> = {
    '練馬〜荻窪（南北の短絡線）': makeLine(['練馬', [139.635, 35.722], [139.625, 35.712], '荻窪']),
    '孤立線（接続なし、練馬区西部）': makeLine([[139.60, 35.75], [139.585, 35.755], [139.57, 35.76]]),
    '環状（赤羽〜池袋〜渋谷〜大井町 を外側で）': makeLine(['赤羽', [139.69, 35.765], '中野', [139.665, 35.66], '大井町']),
    '既存駅の横（荻窪から 300m）': makeLine(['練馬', [139.635, 35.722], [139.6235, 35.7065]]),
  };
  for (const [name, line] of Object.entries(cases)) {
    const t = performance.now();
    const r = runDemand(line, ctx);
    const ms = Math.round(performance.now() - t);
    console.log(`\n== ${name}（${ms} ms）`);
    console.log(`輸送人員 ${Math.round(r.dailyPassengers).toLocaleString()} 人/日、人キロ ${Math.round(r.dailyPassengerKm).toLocaleString()}、内訳`,
      Object.fromEntries(Object.entries(r.tripsByType).map(([k, v]) => [k, Math.round(v)])), '新規鉄道利用人口', Math.round(r.newRailUsersPopulation));
    r.stations.forEach((s, i) => console.log(`  ${(line.vertices[i] as { name?: string }).name}: 乗降 ${Math.round(s.ridership).toLocaleString()}（駅勢圏 ${Math.round(s.fromCatchment).toLocaleString()} / 乗換 ${Math.round(s.fromTransfer).toLocaleString()}）人口 ${s.catchmentPopulation === null ? '-' : Math.round(s.catchmentPopulation)}`));
    r.segments.forEach((s) => console.log(`  区間 ${s.lengthKm.toFixed(1)}km 断面 ${Math.round(s.forward)} / ${Math.round(s.backward)}`));
  }
});
