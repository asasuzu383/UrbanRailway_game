/**
 * 路線（UserLine）の編集操作。すべて純粋関数で、新しい UserLine を返す。
 *
 * 不変条件:
 * - 区間（segments）は「隣り合う 2 駅」ごとに 1 つ、起点駅の id をキーに持つ（normalizeSegments で維持）。
 * - 先頭の駅より前・最後の駅より後の中間点は「未完成部分」として残してよい（計算では無視する）。
 */
import type { LineVertex, LngLat, SegmentAttributes, StationVertex, StructureType, UserLine } from '../core/types';

export type IdGenerator = () => string;

let counter = 0;
/** 既定の ID 生成。保存済みデータの ID と衝突しないよう時刻と乱数を含める */
export const defaultIdGen: IdGenerator = () =>
  `v${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface StationPlacement {
  readonly position: LngLat;
  /** スナップした既存駅（なければ null） */
  readonly transferTo: { id: string; name: string } | null;
}

export function createLine(id: string, name: string, color: string): UserLine {
  return { id, name, color, vertices: [], segments: [] };
}

export function stationsOf(line: UserLine): StationVertex[] {
  return line.vertices.filter((v): v is StationVertex => v.kind === 'station');
}

/** 新駅の仮名（「新駅1」「新駅2」…で未使用のもの） */
export function nextStationName(line: UserLine): string {
  const used = new Set(stationsOf(line).map((s) => s.name));
  for (let n = 1; ; n++) {
    const name = `新駅${n}`;
    if (!used.has(name)) return name;
  }
}

function makeVertex(
  line: UserLine,
  kind: LineVertex['kind'],
  placement: StationPlacement,
  idGen: IdGenerator,
): LineVertex {
  if (kind === 'shape') return { kind: 'shape', id: idGen(), position: placement.position };
  return {
    kind: 'station',
    id: idGen(),
    position: placement.position,
    name: placement.transferTo?.name ?? nextStationName(line),
    transferTo: placement.transferTo?.id ?? null,
  };
}

/**
 * 区間の配列を駅の並びに合わせ直す。既存の区間は構造を保ち、新しくできた区間は
 * 「直前まで同じ場所を通っていた区間」の構造（なければ既定値）を引き継ぐ。
 */
export function normalizeSegments(line: UserLine, defaultStructure: StructureType, previous?: UserLine): UserLine {
  const stations = stationsOf(line);
  const byFrom = new Map(line.segments.map((s) => [s.fromStationId, s]));
  const prevStructureAt = structureLookup(previous ?? line);
  const segments: SegmentAttributes[] = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    const from = stations[i]!;
    const existing = byFrom.get(from.id);
    if (existing) {
      segments.push(existing);
      continue;
    }
    // 区間の途中に挿入された駅: 挿入前にその位置を含んでいた区間の構造を使う。
    // 末尾への延伸など、以前は区間が無かった場所は既定の構造（エディタで選択中のもの）
    const inherited = prevStructureAt(line, i) ?? defaultStructure;
    segments.push({ fromStationId: from.id, structure: inherited });
  }
  return { ...line, segments };
}

/** 変更前の路線で「新しい路線の i 番目の駅から始まる区間」に相当する区間の構造を探す関数を作る */
function structureLookup(previous: UserLine) {
  const prevStations = stationsOf(previous);
  const prevSeg = new Map(previous.segments.map((s) => [s.fromStationId, s.structure]));
  return (line: UserLine, stationIndex: number): StructureType | undefined => {
    const stations = stationsOf(line);
    // 直前の既存駅（変更前にも存在した駅）を遡って探し、その駅から始まっていた区間の構造を返す
    for (let j = stationIndex; j >= 0; j--) {
      const s = stations[j]!;
      if (prevStations.some((p) => p.id === s.id)) return prevSeg.get(s.id);
    }
    return undefined;
  };
}

/** 末尾に頂点を追加する。 */
export function appendVertex(
  line: UserLine,
  kind: LineVertex['kind'],
  placement: StationPlacement,
  defaultStructure: StructureType,
  idGen: IdGenerator = defaultIdGen,
): { line: UserLine; vertexId: string } {
  const v = makeVertex(line, kind, placement, idGen);
  const next = { ...line, vertices: [...line.vertices, v] };
  return { line: normalizeSegments(next, defaultStructure, line), vertexId: v.id };
}

/** afterIndex 番目の頂点の直後に頂点を挿入する（区間の途中への追加）。 */
export function insertVertex(
  line: UserLine,
  afterIndex: number,
  kind: LineVertex['kind'],
  placement: StationPlacement,
  defaultStructure: StructureType,
  idGen: IdGenerator = defaultIdGen,
): { line: UserLine; vertexId: string } {
  if (afterIndex < 0 || afterIndex >= line.vertices.length) throw new RangeError(`afterIndex ${afterIndex} が範囲外`);
  const v = makeVertex(line, kind, placement, idGen);
  const vertices = [...line.vertices.slice(0, afterIndex + 1), v, ...line.vertices.slice(afterIndex + 1)];
  return { line: normalizeSegments({ ...line, vertices }, defaultStructure, line), vertexId: v.id };
}

/** 頂点を移動する。駅の場合はスナップ先（接続駅）も更新する。 */
export function moveVertex(line: UserLine, vertexId: string, placement: StationPlacement): UserLine {
  const vertices = line.vertices.map((v): LineVertex => {
    if (v.id !== vertexId) return v;
    if (v.kind === 'shape') return { ...v, position: placement.position };
    const wasTransfer = v.transferTo !== null;
    const newTransfer = placement.transferTo;
    // スナップ時は既存駅名を採用。スナップ解除時は元の名前が既存駅名のままなので仮名に戻す
    let name = v.name;
    if (newTransfer && newTransfer.id !== v.transferTo) name = newTransfer.name;
    else if (!newTransfer && wasTransfer) name = nextStationName({ ...line, vertices: line.vertices.filter((x) => x.id !== v.id) });
    return { ...v, position: placement.position, transferTo: newTransfer?.id ?? null, name };
  });
  return { ...line, vertices };
}

/** 頂点を削除する。駅を消した場合、前後の区間は前側の区間の構造でつながる。 */
export function removeVertex(line: UserLine, vertexId: string, defaultStructure: StructureType): UserLine {
  const vertices = line.vertices.filter((v) => v.id !== vertexId);
  return normalizeSegments({ ...line, vertices, segments: line.segments.filter((s) => s.fromStationId !== vertexId) }, defaultStructure, line);
}

export function renameStation(line: UserLine, stationId: string, name: string): UserLine {
  const trimmed = name.trim();
  if (!trimmed) return line;
  return {
    ...line,
    vertices: line.vertices.map((v) => (v.id === stationId && v.kind === 'station' ? { ...v, name: trimmed } : v)),
  };
}

export function setSegmentStructure(line: UserLine, fromStationId: string, structure: StructureType): UserLine {
  return {
    ...line,
    segments: line.segments.map((s) => (s.fromStationId === fromStationId ? { ...s, structure } : s)),
  };
}

export function setAllSegmentsStructure(line: UserLine, structure: StructureType): UserLine {
  return { ...line, segments: line.segments.map((s) => ({ ...s, structure })) };
}

/** 路線の向きを反転する（先頭側に延伸したいとき用）。区間の構造は位置を保ったまま付け替える。 */
export function reverseLine(line: UserLine): UserLine {
  const stations = stationsOf(line);
  const structByFrom = new Map(line.segments.map((s) => [s.fromStationId, s.structure]));
  const reversedStations = [...stations].reverse();
  const segments: SegmentAttributes[] = [];
  for (let i = 0; i + 1 < reversedStations.length; i++) {
    // 反転後の区間 (s_i → s_{i+1}) は反転前の区間 (s_{i+1} → s_i) で、その起点は s_{i+1}
    const originalFrom = reversedStations[i + 1]!.id;
    segments.push({ fromStationId: reversedStations[i]!.id, structure: structByFrom.get(originalFrom)! });
  }
  return { ...line, vertices: [...line.vertices].reverse(), segments };
}
