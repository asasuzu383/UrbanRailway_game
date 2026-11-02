/** テスト用: public/data の実データから需要推計のコンテキストを作る（1 回だけ読み込んで共有） */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultDemandParams } from '../../src/config/demand';
import type { LngLat, StructureType, UserLine } from '../../src/core/types';
import type { StationsFile, ZonesFile } from '../../src/data/schema';
import { TimeMatrix } from '../../src/data/timeMatrix';
import { createDemandContext, type DemandContext } from '../../src/demand/context';

const DATA = resolve(__dirname, '../../public/data/shutoken');
let cached: { ctx: DemandContext; stations: StationsFile } | null = null;

export function realContext(): { ctx: DemandContext; stations: StationsFile } {
  if (cached) return cached;
  const zones = JSON.parse(readFileSync(resolve(DATA, 'zones.json'), 'utf-8')) as ZonesFile;
  const stations = JSON.parse(readFileSync(resolve(DATA, 'stations.json'), 'utf-8')) as StationsFile;
  const times = new TimeMatrix(stations.stations.length, new Uint8Array(readFileSync(resolve(DATA, 'times.bin'))));
  cached = { ctx: createDemandContext(zones, stations.stations, times, defaultDemandParams), stations };
  return cached;
}

export function stationIdByName(name: string): string {
  const s = realContext().stations.stations.find((x) => x.name === name);
  if (!s) throw new Error(`駅が見つかりません: ${name}`);
  return s.id;
}

export function stationPos(name: string): LngLat {
  const s = realContext().stations.stations.find((x) => x.name === name)!;
  return [s.lng, s.lat];
}

/** 駅の並び（既存駅名 or 座標）から路線を作る */
export function makeLine(points: readonly (string | LngLat)[], structure: StructureType = 'underground'): UserLine {
  const vertices = points.map((p, i) => {
    const isName = typeof p === 'string';
    return {
      kind: 'station' as const,
      id: `s${i}`,
      position: isName ? stationPos(p) : p,
      name: isName ? p : `新駅${i}`,
      transferTo: isName ? stationIdByName(p) : null,
    };
  });
  return {
    id: 'test',
    name: 'テスト線',
    color: '#000',
    vertices,
    segments: vertices.slice(0, -1).map((v) => ({ fromStationId: v.id, structure })),
  };
}
