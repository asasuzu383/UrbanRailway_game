/**
 * アプリ全体の状態の組み立て: シナリオの読込・自動保存・編集後の再計算（デバウンス）。
 */
import { AUTOSAVE_DEBOUNCE_MS, RECOMPUTE_DEBOUNCE_MS } from '../config/editor';
import type { Scenario } from '../core/types';
import { computeLineGeometry, type LineGeometry } from '../network/lineGeometry';
import { debounce } from './debounce';
import { loadFromStorage, saveToStorage } from './scenarioIO';
import { ScenarioStore, emptyScenario } from './scenarioStore';
import { createStore } from './store';

export const scenarioStore = new ScenarioStore(loadFromStorage() ?? emptyScenario());

/**
 * 再計算の結果。M3 では路線の幾何のみ。M4 で需要推計、M5 で収支を加える。
 * 計算中かどうかを UI で示せるよう status を持つ。
 */
export interface ComputeState {
  readonly status: 'idle' | 'pending';
  readonly geometry: LineGeometry | null;
  readonly computedFor: Scenario | null;
}

export const computeStore = createStore<ComputeState>({ status: 'idle', geometry: null, computedFor: null });

function compute(s: Scenario): void {
  const line = s.lines[0];
  computeStore.set({ status: 'idle', geometry: line ? computeLineGeometry(line) : null, computedFor: s });
}

const recompute = debounce(compute, RECOMPUTE_DEBOUNCE_MS);
const autosave = debounce((s: Scenario) => saveToStorage(s), AUTOSAVE_DEBOUNCE_MS);

let lastScenario = scenarioStore.scenario;
scenarioStore.store.subscribe(({ scenario }) => {
  if (scenario === lastScenario) return;
  lastScenario = scenario;
  computeStore.set((st) => ({ ...st, status: 'pending' }));
  recompute(scenario);
  autosave(scenario);
});

// 起動時に 1 回計算する。ページを離れる前には保存を確定させる
compute(scenarioStore.scenario);
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => autosave.flush());
