/**
 * 需要推計で毎回使う下ごしらえ（起動時に 1 回だけ作る）。
 * ゾーン・既存駅を型付き配列にし、空間インデックスと既存網の ACC を用意する。
 */
import type { DemandParams } from '../config/demand';
import { distanceKm } from '../core/geo';
import { meshCentroid } from '../data/meshCode';
import { GridIndex } from '../data/spatialIndex';
import type { TimeMatrix } from '../data/timeMatrix';

/** 東京駅（都心距離の基準点。scripts/calibrate.py と同じ） */
export const CORE_POINT = [139.7671, 35.6812] as const;

export interface DemandZonesInput {
  readonly code: readonly number[];
  readonly pop: readonly number[];
  readonly emp: readonly number[];
}

export interface DemandStationInput {
  readonly id: string;
  readonly name: string;
  readonly lng: number;
  readonly lat: number;
  readonly mass: number;
  readonly acc: number;
  readonly catch: number;
  readonly muCatch: number;
}

export interface DemandContext {
  readonly params: DemandParams;
  readonly zones: {
    readonly n: number;
    readonly lng: Float64Array;
    readonly lat: Float64Array;
    readonly pop: Float64Array;
    readonly emp: Float64Array;
    /** 鉄道を使わない選択肢の効用 exp(a₀ + a₁·都心距離) */
    readonly outside: Float64Array;
    readonly index: GridIndex;
  };
  readonly stations: {
    readonly n: number;
    readonly id: readonly string[];
    readonly name: readonly string[];
    readonly lng: Float64Array;
    readonly lat: Float64Array;
    readonly mass: Float64Array;
    readonly catch: Float64Array;
    readonly muCatch: Float64Array;
    /** 校正時の ACC（Huff の魅力度の基準。calibrate.py の値） */
    readonly accCalibrated: Float64Array;
    /** times から計算し直した既存網の ACC（新線ありの ACC との比を取るときの基準） */
    readonly accOld: Float64Array;
    readonly index: GridIndex;
    readonly byId: ReadonlyMap<string, number>;
  };
  readonly times: TimeMatrix;
  /** exp(−γ t) の表（t = 0..254 分、255 = 到達不能 → 0） */
  readonly decayTable: Float64Array;
}

export function createDemandContext(
  zonesIn: DemandZonesInput,
  stationsIn: readonly DemandStationInput[],
  times: TimeMatrix,
  params: DemandParams,
): DemandContext {
  const fp = params.fitted;
  const nz = zonesIn.code.length;
  const zlng = new Float64Array(nz);
  const zlat = new Float64Array(nz);
  const outside = new Float64Array(nz);
  for (let i = 0; i < nz; i++) {
    const [lng, lat] = meshCentroid(String(zonesIn.code[i]));
    zlng[i] = lng;
    zlat[i] = lat;
    outside[i] = Math.exp(fp.outsideConst + fp.outsidePerKm * distanceKm(CORE_POINT, [lng, lat]));
  }

  const ns = stationsIn.length;
  if (times.n !== ns) throw new Error(`所要時間行列（${times.n}）と駅数（${ns}）が一致しません`);
  const slng = Float64Array.from(stationsIn, (s) => s.lng);
  const slat = Float64Array.from(stationsIn, (s) => s.lat);
  const mass = Float64Array.from(stationsIn, (s) => s.mass);

  const decayTable = new Float64Array(256);
  for (let t = 0; t < 255; t++) decayTable[t] = Math.exp(-fp.timeDecayPerMin * t);
  decayTable[255] = 0;

  const accOld = new Float64Array(ns);
  for (let o = 0; o < ns; o++) {
    let sum = 0;
    for (let d = 0; d < ns; d++) {
      if (d === o) continue;
      const t = times.get(o, d);
      if (t !== Infinity) sum += mass[d]! * decayTable[t]!;
    }
    accOld[o] = sum;
  }

  return {
    params,
    zones: {
      n: nz,
      lng: zlng,
      lat: zlat,
      pop: Float64Array.from(zonesIn.pop),
      emp: Float64Array.from(zonesIn.emp),
      outside,
      index: new GridIndex(zlng, zlat),
    },
    stations: {
      n: ns,
      id: stationsIn.map((s) => s.id),
      name: stationsIn.map((s) => s.name),
      lng: slng,
      lat: slat,
      mass,
      catch: Float64Array.from(stationsIn, (s) => s.catch),
      muCatch: Float64Array.from(stationsIn, (s) => s.muCatch),
      accCalibrated: Float64Array.from(stationsIn, (s) => s.acc),
      accOld,
      index: new GridIndex(slng, slat),
      byId: new Map(stationsIn.map((s, i) => [s.id, i])),
    },
    times,
    decayTable,
  };
}
