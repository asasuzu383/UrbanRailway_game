import { describe, expect, it } from 'vitest';
import { buildMeshFeatureCollection } from '../src/data/meshGeoJson';
import type { ZonesFile } from '../src/data/schema';

describe('buildMeshFeatureCollection', () => {
  const zones: ZonesFile = {
    version: 1,
    meshLevel: 'half',
    code: [533946113, 533946111],
    pop: [120, 0],
    emp: [5000, 30],
    inRegion: [1, 1],
  };

  it('メッシュごとに閉じた矩形ポリゴンと属性を作る', () => {
    const fc = buildMeshFeatureCollection(zones);
    expect(fc.features).toHaveLength(2);
    const f = fc.features[0]!;
    expect(f.properties).toEqual({ code: 533946113, pop: 120, emp: 5000 });
    const ring = f.geometry.coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it('東京駅を含むメッシュは東京駅の座標を内包する', () => {
    const ring = buildMeshFeatureCollection(zones).features[0]!.geometry.coordinates[0]!;
    const lngs = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    expect(Math.min(...lngs)).toBeLessThan(139.7671);
    expect(Math.max(...lngs)).toBeGreaterThan(139.7671);
    expect(Math.min(...lats)).toBeLessThan(35.6812);
    expect(Math.max(...lats)).toBeGreaterThan(35.6812);
  });
});
