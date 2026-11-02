/**
 * バックテストの推計部分（scripts/backtest.py から呼ばれる）。
 * Python 側が用意したケース（除外後の駅・所要時間・パラメータ・新線）ごとに、ブラウザと同じ需要エンジンを回して
 * 駅別の推計値を JSON に書き出す。通常のテスト（npm test）には含めない。
 *
 *   npx vitest run --config vitest.backtest.config.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'vitest';
import type { DemandParams } from '../../src/config/demand';
import type { UserLine } from '../../src/core/types';
import { TimeMatrix } from '../../src/data/timeMatrix';
import { createDemandContext, type DemandStationInput, type DemandZonesInput } from '../../src/demand/context';
import { runDemandDetailed } from '../../src/demand/engine';
import { computeLineGeometry } from '../../src/network/lineGeometry';
import { validateScenario } from '../../src/state/scenarioIO';

const ROOT = resolve(__dirname, '../..');
const MANIFEST = resolve(ROOT, process.env.BACKTEST_MANIFEST ?? 'data/backtest/manifest.json');

interface Variant {
  readonly id: string;
  readonly stations: string;
  readonly zones: string;
  readonly params: string;
  readonly out: string;
}

interface Manifest {
  readonly cases: readonly { readonly id: string; readonly line: string; readonly times: string; readonly variants: readonly Variant[] }[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), 'utf-8')) as T;

test.skipIf(!existsSync(MANIFEST))('バックテストの推計', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as Manifest;
  for (const c of manifest.cases) {
    // エディタの読み込みと同じ検証を通す（自動生成した新線がエディタで描く新線と同じ形であることの確認）
    const line: UserLine = validateScenario({ schemaVersion: 1, lines: [readJson<UserLine>(c.line)] }).lines[0]!;
    const timesBuf = new Uint8Array(readFileSync(resolve(ROOT, c.times)));
    const geo = computeLineGeometry(line);
    for (const v of c.variants) {
      const stations = readJson<DemandStationInput[]>(v.stations);
      const zones = readJson<DemandZonesInput>(v.zones);
      const params = readJson<DemandParams>(v.params);
      const ctx = createDemandContext(zones, stations, new TimeMatrix(stations.length, timesBuf), params);
      const t0 = performance.now();
      const { result, diagnostics } = runDemandDetailed(line, ctx);
      if (!diagnostics) throw new Error(`${c.id}/${v.id}: 駅が 2 つ未満です`);
      const out = {
        case: c.id,
        variant: v.id,
        totalKm: geo.totalKm,
        elapsedMs: Math.round(performance.now() - t0),
        dailyPassengers: result.dailyPassengers,
        dailyPassengerKm: result.dailyPassengerKm,
        tripsByType: result.tripsByType,
        newRailUsersPopulation: result.newRailUsersPopulation,
        stops: result.stations.map((s, k) => ({
          vertexId: s.stationId,
          name: diagnostics.stops[k]!.name,
          chainageKm: diagnostics.stops[k]!.chainageKm,
          existing: diagnostics.stops[k]!.existing !== null,
          ridership: s.ridership,
          fromCatchment: s.fromCatchment,
          fromTransfer: s.fromTransfer,
          fromThrough: diagnostics.stopThrough[k]!,
          catchmentPopulation: s.catchmentPopulation,
          catchmentEmployees: s.catchmentEmployees,
          catchment: diagnostics.stopCatch[k]!,
          acc: diagnostics.stopAcc[k]!,
          tripEnds: diagnostics.stopTripEnds[k]!,
        })),
        segments: result.segments,
      };
      const outPath = resolve(ROOT, v.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(out, null, 1));
      console.log(`${c.id}/${v.id}: 乗降合計 ${Math.round(out.stops.reduce((a, s) => a + s.ridership, 0)).toLocaleString()} 人/日（${out.elapsedMs} ms）`);
    }
  }
}, 600_000);
