import { describe, expect, it } from 'vitest';
import { halfMeshCodeAt, meshBounds, meshCentroid } from '../src/data/meshCode';

describe('meshCode', () => {
  it('東京駅付近の 3次メッシュは 53394611', () => {
    // 東京駅 35.6812N, 139.7671E
    expect(halfMeshCodeAt(139.7671, 35.6812).slice(0, 8)).toBe('53394611');
  });

  it('コード → 範囲 → コード が往復する', () => {
    for (const code of ['533946114', '533946111', '543900002', '523976993']) {
      const [lng, lat] = meshCentroid(code);
      expect(halfMeshCodeAt(lng, lat)).toBe(code);
    }
  });

  it('2分の1メッシュは 3次メッシュを 2×2 分割する', () => {
    const third = meshBounds('53394611');
    const sw = meshBounds('533946111');
    const ne = meshBounds('533946114');
    expect(sw.south).toBeCloseTo(third.south, 10);
    expect(sw.west).toBeCloseTo(third.west, 10);
    expect(ne.north).toBeCloseTo(third.north, 10);
    expect(ne.east).toBeCloseTo(third.east, 10);
  });

  it('不正なコードは例外', () => {
    expect(() => meshBounds('12345')).toThrow();
  });
});
