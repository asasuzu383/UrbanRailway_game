import { createStore } from './store';

export type MeshMode = 'none' | 'pop' | 'emp';

/** 地図レイヤーの表示状態。 */
export interface ViewState {
  readonly showLines: boolean;
  /** 非表示にした事業者（「その他」はまとめて OTHER_OPERATOR_LABEL で扱う） */
  readonly hiddenOperators: ReadonlySet<string>;
  readonly showStations: boolean;
  readonly meshMode: MeshMode;
  readonly showRegion: boolean;
}

export const initialViewState: ViewState = {
  showLines: true,
  hiddenOperators: new Set(),
  showStations: true,
  meshMode: 'none',
  showRegion: true,
};

export const viewStore = createStore<ViewState>(initialViewState);
