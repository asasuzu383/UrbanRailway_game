import { DEFAULT_LINE_COLOR, DEFAULT_LINE_NAME, UNDO_LIMIT } from '../config/editor';
import type { Scenario, UserLine } from '../core/types';
import { createLine, defaultIdGen } from '../network/lineModel';
import { createStore, type Store } from './store';

export interface ScenarioState {
  readonly scenario: Scenario;
  readonly past: readonly Scenario[];
  readonly future: readonly Scenario[];
}

export function emptyScenario(): Scenario {
  return { schemaVersion: 1, lines: [createLine(defaultIdGen(), DEFAULT_LINE_NAME, DEFAULT_LINE_COLOR)] };
}

/**
 * シナリオ（ユーザーが作った路線）の状態と編集履歴。
 * ドラッグ中のように連続して変わる変更は transient で反映し、確定時に 1 回だけ履歴に積む。
 */
export class ScenarioStore {
  readonly store: Store<ScenarioState>;
  /** transient 変更が始まる前の状態（確定時に履歴へ積む） */
  private transientBase: Scenario | null = null;

  constructor(initial: Scenario) {
    this.store = createStore<ScenarioState>({ scenario: initial, past: [], future: [] });
  }

  get scenario(): Scenario {
    return this.store.get().scenario;
  }

  /** Phase 1 は 1 路線を編集する（データ構造は複数路線に対応） */
  get activeLine(): UserLine {
    return this.scenario.lines[0]!;
  }

  updateLine(fn: (line: UserLine) => UserLine, opts: { transient?: boolean } = {}): void {
    const s = this.scenario;
    const line = s.lines[0]!;
    const next = fn(line);
    if (next === line) return;
    this.apply({ ...s, lines: [next, ...s.lines.slice(1)] }, opts.transient ?? false);
  }

  replace(scenario: Scenario): void {
    this.apply(scenario, false);
  }

  /** transient 変更を確定して履歴に積む */
  commitTransient(): void {
    const base = this.transientBase;
    this.transientBase = null;
    if (!base) return;
    this.store.set((st) => (base === st.scenario ? st : { ...st, past: pushLimited(st.past, base), future: [] }));
  }

  undo(): void {
    this.commitTransient();
    this.store.set((st) => {
      const prev = st.past[st.past.length - 1];
      if (!prev) return st;
      return { scenario: prev, past: st.past.slice(0, -1), future: [st.scenario, ...st.future] };
    });
  }

  redo(): void {
    this.commitTransient();
    this.store.set((st) => {
      const [next, ...rest] = st.future;
      if (!next) return st;
      return { scenario: next, past: pushLimited(st.past, st.scenario), future: rest };
    });
  }

  private apply(next: Scenario, transient: boolean): void {
    if (transient) {
      if (!this.transientBase) this.transientBase = this.scenario;
      this.store.set((st) => ({ ...st, scenario: next }));
      return;
    }
    this.commitTransient();
    this.store.set((st) => ({ scenario: next, past: pushLimited(st.past, st.scenario), future: [] }));
  }
}

function pushLimited<T>(arr: readonly T[], item: T): T[] {
  const out = [...arr, item];
  return out.length > UNDO_LIMIT ? out.slice(out.length - UNDO_LIMIT) : out;
}
