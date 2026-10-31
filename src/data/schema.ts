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
