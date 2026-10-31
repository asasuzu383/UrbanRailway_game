import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/core/types';
import { appendVertex } from '../src/network/lineModel';
import { ScenarioFormatError, parseScenarioJson, serializeScenario, validateScenario } from '../src/state/scenarioIO';
import { ScenarioStore } from '../src/state/scenarioStore';

const base: Scenario = {
  schemaVersion: 1,
  lines: [{
    id: 'L', name: '新線', color: '#222',
    vertices: [
      { kind: 'station', id: 'a', position: [139.7, 35.69], name: 'A', transferTo: 'g1' },
      { kind: 'shape', id: 'x', position: [139.71, 35.70] },
      { kind: 'station', id: 'b', position: [139.72, 35.69], name: 'B', transferTo: null },
    ],
    segments: [{ fromStationId: 'a', structure: 'underground' }],
  }],
};

describe('scenarioIO', () => {
  it('シリアライズして読み戻すと同じになる', () => {
    expect(parseScenarioJson(serializeScenario(base))).toEqual(base);
  });

  it.each([
    ['JSON でない', '{'],
    ['バージョン違い', JSON.stringify({ ...base, schemaVersion: 2 })],
    ['構造の値が不正', JSON.stringify({ ...base, lines: [{ ...base.lines[0], segments: [{ fromStationId: 'a', structure: 'tunnel' }] }] })],
    ['区間と駅の不一致', JSON.stringify({ ...base, lines: [{ ...base.lines[0], segments: [] }] })],
    ['座標が範囲外', JSON.stringify({ ...base, lines: [{ ...base.lines[0], vertices: [{ kind: 'shape', id: 'z', position: [0, 0] }], segments: [] }] })],
  ])('%s は ScenarioFormatError', (_label, text) => {
    expect(() => parseScenarioJson(text)).toThrow(ScenarioFormatError);
  });

  it('余計なプロパティは捨てる', () => {
    const withExtra = { ...base, extra: 1, lines: [{ ...base.lines[0], foo: 'bar' }] };
    expect(validateScenario(withExtra)).toEqual(base);
  });
});

describe('ScenarioStore', () => {
  const add = (store: ScenarioStore, lng: number, opts?: { transient?: boolean }) =>
    store.updateLine((l) => appendVertex(l, 'station', { position: [lng, 35.69], transferTo: null }, 'atGrade').line, opts);

  it('undo / redo で編集を戻せる', () => {
    const st = new ScenarioStore(base);
    add(st, 139.74);
    add(st, 139.76);
    expect(st.activeLine.vertices).toHaveLength(5);
    st.undo();
    expect(st.activeLine.vertices).toHaveLength(4);
    st.undo();
    expect(st.scenario).toBe(base);
    st.redo();
    expect(st.activeLine.vertices).toHaveLength(4);
  });

  it('transient 変更は確定時に 1 回分の履歴になる', () => {
    const st = new ScenarioStore(base);
    for (const lng of [139.8, 139.81, 139.82]) {
      st.updateLine((l) => ({ ...l, vertices: l.vertices.map((v) => (v.id === 'b' ? { ...v, position: [lng, 35.69] as const } : v)) }), { transient: true });
    }
    st.commitTransient();
    expect(st.store.get().past).toHaveLength(1);
    st.undo();
    expect(st.scenario).toBe(base);
  });
});
