import { CURRENT_REGION } from '../config/regions';
import type { FeatureCollection, LineString, MultiLineString, Polygon, MultiPolygon } from 'geojson';
import type { NetworkFile, RailLineProperties, StationsFile, ZonesFile } from './schema';
import type { LandPriceFile } from '../finance/landPrice';
import { TimeMatrix } from './timeMatrix';

/** アプリ起動時に読み込む加工済みデータ一式。 */
export interface BaseData {
  readonly zones: ZonesFile;
  readonly stations: StationsFile;
  readonly network: NetworkFile;
  readonly railLines: FeatureCollection<LineString | MultiLineString, RailLineProperties>;
  readonly region: FeatureCollection<Polygon | MultiPolygon>;
  /** 既存駅間の所要時間（stations の並び） */
  readonly times: TimeMatrix;
  /** 地価公示ポイント（読めなければ null。用地費は 0 になる） */
  readonly landPrice: LandPriceFile | null;
}

/** GitHub Pages のサブパス配信に対応するため、BASE_URL を前置して public/data/<地域>/ を参照する。 */
export function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${CURRENT_REGION.dataDir}/${file}`;
}

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(dataUrl(file));
  if (!res.ok) throw new Error(`${file} の読み込みに失敗しました（HTTP ${res.status}）`);
  return (await res.json()) as T;
}

export async function loadBaseData(): Promise<BaseData> {
  const [zones, stations, network, railLines, region, timesBuf, landPrice] = await Promise.all([
    fetchJson<ZonesFile>('zones.json'),
    fetchJson<StationsFile>('stations.json'),
    fetchJson<NetworkFile>('network.json'),
    fetchJson<BaseData['railLines']>('rail_lines.geojson'),
    fetchJson<BaseData['region']>('region.geojson'),
    fetch(dataUrl('times.bin')).then((r) => {
      if (!r.ok) throw new Error(`times.bin の読み込みに失敗しました（HTTP ${r.status}）`);
      return r.arrayBuffer();
    }),
    fetchJson<LandPriceFile>('landprice.json').catch((e: unknown) => {
      console.warn('地価データを読み込めませんでした（用地費は 0 として計算します）', e);
      return null;
    }),
  ]);
  const times = new TimeMatrix(stations.stations.length, new Uint8Array(timesBuf));
  return { zones, stations, network, railLines, region, times, landPrice };
}
