import { describe, expect, it } from 'vitest';
import type { LngLat, UserLine } from '../src/core/types';
import {
  appendVertex,
  createLine,
  insertVertex,
  moveVertex,
  removeVertex,
  renameStation,
  reverseLine,
  setSegmentStructure,
  stationsOf,
} from '../src/network/lineModel';

function ids() {
  let n = 0;
  return () => `id${++n}`;
}

const P = (lng: number, lat: number): { position: LngLat; transferTo: null } => ({ position: [lng, lat], transferTo: null });

/** A(id1) - B(id2) - C(id3) の 3 駅の路線（区間は地平） */
function threeStations(): UserLine {
  const gen = ids();
  let line = createLine('L', '新線', '#000');
  line = appendVertex(line, 'station', P(139.70, 35.69), 'atGrade', gen).line;
  line = appendVertex(line, 'station', P(139.72, 35.69), 'atGrade', gen).line;
  line = appendVertex(line, 'station', P(139.74, 35.69), 'atGrade', gen).line;
  return line;
}

describe('lineModel', () => {
  it('駅を追加すると隣接駅間ごとに区間ができ、仮名が振られる', () => {
    const line = threeStations();
    expect(stationsOf(line).map((s) => s.name)).toEqual(['新駅1', '新駅2', '新駅3']);
    expect(line.segments.map((s) => s.fromStationId)).toEqual(['id1', 'id2']);
  });

  it('既存駅にスナップした駅は接続駅になり、既存駅名を使う', () => {
    const line = appendVertex(createLine('L', 'x', '#000'), 'station',
      { position: [139.7, 35.69], transferTo: { id: 'g1', name: '新宿' } }, 'atGrade', ids()).line;
    const s = stationsOf(line)[0]!;
    expect(s.transferTo).toBe('g1');
    expect(s.name).toBe('新宿');
  });

  it('末尾への延伸は既定の構造、途中への挿入は元の区間の構造を引き継ぐ', () => {
    let line = setSegmentStructure(threeStations(), 'id1', 'underground');
    line = appendVertex(line, 'station', P(139.76, 35.69), 'elevated', () => 'id4').line;
    expect(line.segments.map((s) => s.structure)).toEqual(['underground', 'atGrade', 'elevated']);

    // A(地下)B の間に駅を挿入 → A-new も new-B も地下
    line = insertVertex(line, 0, 'station', P(139.71, 35.69), 'atGrade', () => 'id5').line;
    expect(stationsOf(line).map((s) => s.id)).toEqual(['id1', 'id5', 'id2', 'id3', 'id4']);
    expect(line.segments.map((s) => s.structure)).toEqual(['underground', 'underground', 'atGrade', 'elevated']);
  });

  it('中間点の挿入では区間の数は変わらない', () => {
    const line = insertVertex(threeStations(), 0, 'shape', P(139.71, 35.70), 'atGrade', () => 's1').line;
    expect(line.vertices.map((v) => v.kind)).toEqual(['station', 'shape', 'station', 'station']);
    expect(line.segments).toHaveLength(2);
  });

  it('途中の駅を消すと前後の区間は前側の構造でつながる', () => {
    let line = setSegmentStructure(threeStations(), 'id1', 'elevated');
    line = setSegmentStructure(line, 'id2', 'underground');
    line = removeVertex(line, 'id2', 'atGrade');
    expect(line.segments).toEqual([{ fromStationId: 'id1', structure: 'elevated' }]);
  });

  it('先頭の駅を消すと 2 番目の駅が起点になる', () => {
    const line = removeVertex(threeStations(), 'id1', 'atGrade');
    expect(line.segments.map((s) => s.fromStationId)).toEqual(['id2']);
  });

  it('移動でスナップすると接続駅に、離すと解除されて仮名に戻る', () => {
    let line = moveVertex(threeStations(), 'id2', { position: [139.7, 35.7], transferTo: { id: 'g9', name: '大久保' } });
    expect(stationsOf(line)[1]).toMatchObject({ transferTo: 'g9', name: '大久保', position: [139.7, 35.7] });
    line = moveVertex(line, 'id2', P(139.73, 35.68));
    expect(stationsOf(line)[1]).toMatchObject({ transferTo: null, name: '新駅2' });
  });

  it('改名は空文字を無視する', () => {
    const line = renameStation(threeStations(), 'id1', '  ');
    expect(stationsOf(line)[0]!.name).toBe('新駅1');
    expect(stationsOf(renameStation(line, 'id1', ' 中央 '))[0]!.name).toBe('中央');
  });

  it('反転しても各区間の構造は同じ場所に残る', () => {
    const line = reverseLine(setSegmentStructure(threeStations(), 'id1', 'underground'));
    expect(stationsOf(line).map((s) => s.id)).toEqual(['id3', 'id2', 'id1']);
    // C→B は元の B→C（地平）、B→A は元の A→B（地下）
    expect(line.segments).toEqual([
      { fromStationId: 'id3', structure: 'atGrade' },
      { fromStationId: 'id2', structure: 'underground' },
    ]);
  });
});
