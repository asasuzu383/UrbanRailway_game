import { DEFAULT_STRUCTURE } from '../config/editor';
import type { LngLat, StructureType } from '../core/types';
import { createStore } from './store';

/** select: 選択・移動、station: 駅を置く、shape: 中間点を置く */
export type EditorTool = 'select' | 'station' | 'shape';

export interface EditorState {
  readonly tool: EditorTool;
  readonly selectedVertexId: string | null;
  /** 新しく延伸する区間の構造 */
  readonly defaultStructure: StructureType;
  /** パネルから地図の移動を求める要求（seq が変わるたびに移動する） */
  readonly focus: { readonly position: LngLat; readonly seq: number } | null;
}

export const editorStore = createStore<EditorState>({
  tool: 'station',
  selectedVertexId: null,
  defaultStructure: DEFAULT_STRUCTURE,
  focus: null,
});

export function focusOn(position: LngLat): void {
  editorStore.set((s) => ({ ...s, focus: { position, seq: (s.focus?.seq ?? 0) + 1 } }));
}
