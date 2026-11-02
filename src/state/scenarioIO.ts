/**
 * シナリオの保存（localStorage）と JSON 入出力。読み込み時は必ず validateScenario で検証する。
 */
import { TRANSIT_TYPE_ORDER, type TransitTypeId } from '../config/transitTypes';
import { CURRENT_REGION } from '../config/regions';

const STORAGE_KEY = CURRENT_REGION.storageKeys.scenario;
import type { LineVertex, Scenario, SegmentAttributes, StructureType, UserLine } from '../core/types';

const STRUCTURES: readonly StructureType[] = ['street', 'atGrade', 'elevated', 'underground'];

export class ScenarioFormatError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

function fail(path: string, msg: string): never {
  throw new ScenarioFormatError(`${path}: ${msg}`);
}

function parseVertex(v: unknown, path: string): LineVertex {
  if (!isObj(v)) fail(path, 'オブジェクトではありません');
  if (!isStr(v.id) || !v.id) fail(path, 'id がありません');
  const pos = v.position;
  if (!Array.isArray(pos) || pos.length !== 2 || !isNum(pos[0]) || !isNum(pos[1])) fail(path, 'position が [経度, 緯度] ではありません');
  const [lng, lat] = pos as [number, number];
  if (lng < 120 || lng > 155 || lat < 20 || lat > 50) fail(path, '座標が日本の範囲外です');
  if (v.kind === 'shape') return { kind: 'shape', id: v.id, position: [lng, lat] };
  if (v.kind !== 'station') fail(path, 'kind は station / shape のいずれかです');
  if (!isStr(v.name)) fail(path, 'name がありません');
  if (v.transferTo !== null && !isStr(v.transferTo)) fail(path, 'transferTo は文字列か null です');
  return { kind: 'station', id: v.id, position: [lng, lat], name: v.name, transferTo: v.transferTo };
}

function parseLine(l: unknown, path: string): UserLine {
  if (!isObj(l)) fail(path, 'オブジェクトではありません');
  if (!isStr(l.id) || !isStr(l.name) || !isStr(l.color)) fail(path, 'id / name / color がありません');
  if (!Array.isArray(l.vertices) || !Array.isArray(l.segments)) fail(path, 'vertices / segments が配列ではありません');
  const vertices = l.vertices.map((v, i) => parseVertex(v, `${path}.vertices[${i}]`));
  const ids = new Set<string>();
  for (const v of vertices) {
    if (ids.has(v.id)) fail(path, `頂点 id が重複しています（${v.id}）`);
    ids.add(v.id);
  }
  const stationIds = vertices.filter((v) => v.kind === 'station').map((v) => v.id);
  const segments: SegmentAttributes[] = l.segments.map((s, i) => {
    const p = `${path}.segments[${i}]`;
    if (!isObj(s) || !isStr(s.fromStationId)) fail(p, 'fromStationId がありません');
    if (!STRUCTURES.includes(s.structure as StructureType)) fail(p, `structure は ${STRUCTURES.join(' / ')} のいずれかです`);
    return { fromStationId: s.fromStationId, structure: s.structure as StructureType };
  });
  // 区間は「最後の駅以外の各駅」から 1 つずつ
  const expected = stationIds.slice(0, -1);
  const actual = segments.map((s) => s.fromStationId);
  if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
    fail(path, '区間の並びが駅の並びと一致しません');
  }
  if (l.transitType !== undefined && !TRANSIT_TYPE_ORDER.includes(l.transitType as TransitTypeId)) {
    fail(path, `transitType は ${TRANSIT_TYPE_ORDER.join(' / ')} のいずれかです`);
  }
  const base = { id: l.id, name: l.name, color: l.color, vertices, segments };
  return l.transitType === undefined ? base : { ...base, transitType: l.transitType as TransitTypeId };
}

export function validateScenario(data: unknown): Scenario {
  if (!isObj(data)) fail('$', 'オブジェクトではありません');
  if (data.schemaVersion !== 1) fail('$.schemaVersion', `未対応のバージョンです（${String(data.schemaVersion)}）`);
  if (!Array.isArray(data.lines) || data.lines.length === 0) fail('$.lines', '路線が 1 つ以上必要です');
  return { schemaVersion: 1, lines: data.lines.map((l, i) => parseLine(l, `$.lines[${i}]`)) };
}

export function serializeScenario(s: Scenario): string {
  return JSON.stringify(s, null, 2);
}

export function parseScenarioJson(text: string): Scenario {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ScenarioFormatError('JSON として読み取れません');
  }
  return validateScenario(data);
}

/** localStorage から読む。無い・壊れている・使えない（プライベートモード等）場合は null。 */
export function loadFromStorage(): Scenario | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? parseScenarioJson(text) : null;
  } catch (e) {
    console.warn('保存データを読み込めませんでした', e);
    return null;
  }
}

export function saveToStorage(s: Scenario): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    console.warn('保存できませんでした', e);
    return false;
  }
}
