/**
 * public/data/*.json の生の形（scripts/ が書き出す形式）。
 * アプリ内では loaders.ts で core/types.ts のドメイン型へ変換して使う。
 */

export interface ZonesFile {
  readonly version: 1;
  readonly meshLevel: 'half';
  readonly code: readonly number[];
  readonly pop: readonly number[];
  readonly emp: readonly number[];
  readonly inRegion: readonly (0 | 1)[];
}

export interface StationRecord {
  readonly id: string;
  readonly name: string;
  readonly lng: number;
  readonly lat: number;
  /** network.json の lines の添字 */
  readonly lines: readonly number[];
  readonly operators: readonly string[];
  readonly inRegion: 0 | 1;
  /** 乗降集計クラスタ（代表駅の id） */
  readonly cluster: string;
  /** 年度 → 1日あたり乗降客数。クラスタの代表駅以外は null */
  readonly ridership: Readonly<Record<string, number | null>>;
  readonly partial: boolean;
  readonly includesShinkansen: boolean;
  /** 以下は scripts/calibrate.py の出力 */
  /** ACC: 既存網での重力型アクセシビリティ */
  readonly acc: number;
  /** M: 目的地としての集中量（従業者＋ψ×人口の幾何的按分） */
  readonly mass: number;
  /** X: Huff 按分後の駅勢圏（人口＋ρ×従業者） */
  readonly catch: number;
  /** 駅勢圏由来の乗降推計（路線数の項を除く） */
  readonly muCatch: number;
}

export interface StationsFile {
  readonly version: 1;
  readonly years: readonly number[];
  readonly stations: readonly StationRecord[];
}

export interface NetworkLine {
  readonly id: number;
  readonly name: string;
  readonly operator: string;
  readonly operatorType: number;
  readonly railType: number;
  readonly speedKmh: number;
}

export interface NetworkFile {
  readonly version: 1;
  readonly lines: readonly NetworkLine[];
  /** [駅a, 駅b, 路線添字, 線路延長m] */
  readonly edges: readonly (readonly [number, number, number, number])[];
  /** [駅a, 駅b, 直線距離m] */
  readonly walk: readonly (readonly [number, number, number])[];
}

export interface RailLineProperties {
  readonly id: number;
  readonly name: string;
  readonly operator: string;
  readonly operatorType: number;
}
