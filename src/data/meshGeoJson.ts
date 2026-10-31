import type { FeatureCollection, Polygon } from 'geojson';
import { meshBounds } from './meshCode';
import type { ZonesFile } from './schema';

export interface MeshProperties {
  readonly code: number;
  readonly pop: number;
  readonly emp: number;
}

/** zones.json（コードのみ）からメッシュの矩形ポリゴンを復元する。 */
export function buildMeshFeatureCollection(zones: ZonesFile): FeatureCollection<Polygon, MeshProperties> {
  const features = zones.code.map((code, i) => {
    const b = meshBounds(String(code));
    return {
      type: 'Feature' as const,
      id: i,
      properties: { code, pop: zones.pop[i] ?? 0, emp: zones.emp[i] ?? 0 },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [b.west, b.south],
          [b.east, b.south],
          [b.east, b.north],
          [b.west, b.north],
          [b.west, b.south],
        ]],
      },
    };
  });
  return { type: 'FeatureCollection', features };
}
