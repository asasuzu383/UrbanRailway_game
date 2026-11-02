import type { StructureType } from '../core/types';

/** 路線エディタの設定。 */

/**
 * 既存駅へのスナップ判定の半径。画面上の距離 [px] で判定し、ズームによって極端にならないよう
 * 地上距離 [m] で下限・上限をかける。（仮置き）
 */
export const SNAP_RADIUS_PX = 14;
export const SNAP_MIN_M = 100;
export const SNAP_MAX_M = 400;

export const DEFAULT_LINE_NAME = '新線';
export const DEFAULT_LINE_COLOR = '#222222';
export const DEFAULT_STRUCTURE: StructureType = 'atGrade';

export const STRUCTURE_LABELS: Readonly<Record<StructureType, string>> = {
  street: '併用軌道',
  atGrade: '地平',
  elevated: '高架',
  underground: '地下',
};
export const STRUCTURE_ORDER: readonly StructureType[] = ['street', 'atGrade', 'elevated', 'underground'];

export const UNDO_LIMIT = 100;
export const AUTOSAVE_DEBOUNCE_MS = 500;
/** 編集後に再計算を走らせるまでの待ち時間 [ms] */
export const RECOMPUTE_DEBOUNCE_MS = 300;
