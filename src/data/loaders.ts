import type { FeatureCollection, LineString, MultiLineString, Polygon, MultiPolygon } from 'geojson';
import type { NetworkFile, RailLineProperties, StationsFile, ZonesFile } from './schema';

/** アプリ起動時に読み込む加工済みデータ一式。 */
export interface BaseData {
  readonly zones: ZonesFile;
  readonly stations: StationsFile;
  readonly network: NetworkFile;
  readonly railLines: FeatureCollection<LineString | MultiLineString, RailLineProperties>;
  readonly region: FeatureCollection<Polygon | MultiPolygon>;
}

/** GitHub Pages のサブパス配信に対応するため、BASE_URL を前置して public/data を参照する。 */
export function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${file}`;
}

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(dataUrl(file));
  if (!res.ok) throw new Error(`${file} の読み込みに失敗しました（HTTP ${res.status}）`);
  return (await res.json()) as T;
}

export async function loadBaseData(): Promise<BaseData> {
  const [zones, stations, network, railLines, region] = await Promise.all([
    fetchJson<ZonesFile>('zones.json'),
    fetchJson<StationsFile>('stations.json'),
    fetchJson<NetworkFile>('network.json'),
    fetchJson<BaseData['railLines']>('rail_lines.geojson'),
    fetchJson<BaseData['region']>('region.geojson'),
  ]);
  return { zones, stations, network, railLines, region };
}
