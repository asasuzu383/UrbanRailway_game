/**
 * 地図表示の設定（色・凡例の階級・初期表示）。需要や費用のパラメータとは分けて置く。
 */

/**
 * 既存路線の事業者別の色。路線延長の大きい主要事業者だけに固有色を割り当て、
 * それ以外は「その他」の灰色にまとめる（色数が増えると互いに区別できなくなるため）。
 * 各社のコーポレートカラーを参考にしつつ、隣接して走る事業者どうしが似ないよう調整している。
 */
export const OPERATOR_COLORS: Readonly<Record<string, string>> = {
  東日本旅客鉄道: '#1a9a3a',
  東京地下鉄: '#0096d6',
  東京都: '#8a4fbf',
  東武鉄道: '#ef7a00',
  京成電鉄: '#5a7d1e',
  西武鉄道: '#d9a400',
  小田急電鉄: '#1f4fa3',
  東急電鉄: '#e3262f',
  京王電鉄: '#d6337a',
  京浜急行電鉄: '#ff7f6e',
  相模鉄道: '#2b9bb0',
  首都圏新都市鉄道: '#a0522d',
};
export const OTHER_OPERATOR_COLOR = '#7a7a7a';
export const OTHER_OPERATOR_LABEL = 'その他';

export function operatorColor(operator: string): string {
  return OPERATOR_COLORS[operator] ?? OTHER_OPERATOR_COLOR;
}

/** 事業者名の表示用短縮名 */
export const OPERATOR_SHORT_NAMES: Readonly<Record<string, string>> = {
  東日本旅客鉄道: 'JR東日本',
  東海旅客鉄道: 'JR東海',
  東京地下鉄: '東京メトロ',
  東京都: '都営',
  横浜市: '横浜市営',
  首都圏新都市鉄道: 'つくばエクスプレス',
  京浜急行電鉄: '京急',
};

export function operatorLabel(operator: string): string {
  return OPERATOR_SHORT_NAMES[operator] ?? operator;
}

/** メッシュ階級区分図。1メッシュ（約0.26km²）あたりの人数。単一色相の明→暗 */
export interface MeshClassScheme {
  readonly label: string;
  readonly unit: string;
  /** 各階級の下限（先頭は 0） */
  readonly breaks: readonly number[];
  readonly colors: readonly string[];
}

export const MESH_SCHEMES: Readonly<Record<'pop' | 'emp', MeshClassScheme>> = {
  pop: {
    label: '夜間人口（2020年）',
    unit: '人/500mメッシュ',
    breaks: [0, 100, 500, 1000, 2000, 4000, 7000],
    colors: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  },
  emp: {
    label: '従業者数（2021年）',
    unit: '人/500mメッシュ',
    breaks: [0, 50, 200, 500, 1000, 3000, 10000],
    colors: ['#fde3d6', '#f9c1a5', '#f49b74', '#eb6834', '#c94e1d', '#9c3a14', '#6e2810'],
  },
};

export const MESH_OPACITY = 0.6;

/** 初期表示範囲 [西, 南, 東, 北] */
export const INITIAL_BOUNDS: [number, number, number, number] = [139.0, 35.1, 140.6, 36.2];
