import { describe, expect, it } from 'vitest';
import type { UserLine } from '../src/core/types';
import { computeLineGeometry } from '../src/network/lineGeometry';
import { findSnapTarget } from '../src/network/snap';

const line: UserLine = {
  id: 'L',
  name: '新線',
  color: '#000',
  vertices: [
    { kind: 'shape', id: 'x0', position: [139.69, 35.69] }, // 先頭駅より前（未完成部分）
    { kind: 'station', id: 'a', position: [139.70, 35.69], name: 'A', transferTo: null },
    { kind: 'shape', id: 'x1', position: [139.71, 35.70] },
    { kind: 'station', id: 'b', position: [139.72, 35.69], name: 'B', transferTo: null },
    { kind: 'station', id: 'c', position: [139.72, 35.70], name: 'C', transferTo: 'g1' },
    { kind: 'shape', id: 'x2', position: [139.73, 35.71] }, // 最終駅より後（未完成部分）
  ],
  segments: [
    { fromStationId: 'a', structure: 'underground' },
    { fromStationId: 'b', structure: 'elevated' },
  ],
};

describe('computeLineGeometry', () => {
  const g = computeLineGeometry(line);

  it('駅間ごとに中間点を含む座標列を作り、未完成部分は除く', () => {
    expect(g.stations.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(g.segments.map((s) => s.coordinates.length)).toEqual([3, 2]);
    expect(g.segments[0]!.coordinates[0]).toEqual([139.70, 35.69]);
  });

  it('延長は中間点経由で、構造別に集計される', () => {
    // B-C は南北に 0.01 度 ≒ 1.11km
    expect(g.segments[1]!.lengthKm).toBeCloseTo(1.112, 2);
    // A-B は中間点経由なので直線（約1.81km）より長い
    expect(g.segments[0]!.lengthKm).toBeGreaterThan(1.81);
    expect(g.kmByStructure.underground).toBeCloseTo(g.segments[0]!.lengthKm, 10);
    expect(g.kmByStructure.elevated).toBeCloseTo(g.segments[1]!.lengthKm, 10);
    expect(g.kmByStructure.atGrade).toBe(0);
    expect(g.totalKm).toBeCloseTo(g.segments[0]!.lengthKm + g.segments[1]!.lengthKm, 10);
    expect(g.chainageKm).toHaveLength(3);
  });

  it('駅が 1 つ以下なら区間はない', () => {
    const one = computeLineGeometry({ ...line, vertices: line.vertices.slice(0, 2), segments: [] });
    expect(one.segments).toHaveLength(0);
    expect(one.totalKm).toBe(0);
  });
});

describe('findSnapTarget', () => {
  const cands = [
    { id: 's1', name: '甲', position: [139.700, 35.690] as const },
    { id: 's2', name: '乙', position: [139.702, 35.690] as const },
  ];

  it('半径内で最も近い駅を返す', () => {
    // s2 の東 約45m
    expect(findSnapTarget([139.7025, 35.690], cands, 150)?.id).toBe('s2');
  });

  it('半径外なら null', () => {
    expect(findSnapTarget([139.71, 35.690], cands, 150)).toBeNull();
  });
});
