import { distanceKm } from '../core/geo';
import type { LngLat } from '../core/types';
import { GridIndex } from '../data/spatialIndex';

export interface LandPriceFile {
  readonly year: number;
  /** [経度, 緯度, 円/m², 用途区分] */
  readonly points: readonly (readonly [number, number, number, string])[];
}

class PointSet {
  readonly lng: Float64Array;
  readonly lat: Float64Array;
  readonly price: Float64Array;
  readonly index: GridIndex;

  constructor(pts: LandPriceFile['points']) {
    this.lng = Float64Array.from(pts, (p) => p[0]);
    this.lat = Float64Array.from(pts, (p) => p[1]);
    this.price = Float64Array.from(pts, (p) => p[2]);
    this.index = new GridIndex(this.lng, this.lat, 0.05);
  }

  near(p: LngLat, radiusKm: number): { d: number; v: number }[] {
    const out: { d: number; v: number }[] = [];
    for (const i of this.index.near(p[0], p[1], radiusKm)) {
      const d = distanceKm(p, [this.lng[i]!, this.lat[i]!]);
      if (d <= radiusKm) out.push({ d, v: this.price[i]! });
    }
    return out;
  }
}

/**
 * 地価公示ポイントからの逆距離加重（IDW）による地価の推定。
 * 鉄道用地の買収は住宅地の価格水準に近いと考え、住宅地（用途区分 000）の地点を優先し、
 * 近くに住宅地の地点がない場合だけ他の用途（商業地・工業地など。林地は除く）を使う。
 * 駅前の商業地の価格を線路全体に当てはめると用地費が過大になるため。
 */
export class LandPriceIndex {
  private readonly residential: PointSet;
  private readonly others: PointSet;

  constructor(file: LandPriceFile) {
    this.residential = new PointSet(file.points.filter((p) => p[3] === '000'));
    this.others = new PointSet(file.points.filter((p) => p[3] !== '000' && p[3] !== '013'));
  }

  /** 位置の地価 [円/m²]。半径 radiusKm 以内の近い k 地点の IDW（距離の 2 乗）。見つからなければ null */
  at(p: LngLat, k = 4, radiusKm = 3): number | null {
    let cands = this.residential.near(p, radiusKm);
    if (cands.length === 0) cands = this.others.near(p, radiusKm);
    if (cands.length === 0) return null;
    cands.sort((a, b) => a.d - b.d);
    let num = 0;
    let den = 0;
    for (const c of cands.slice(0, k)) {
      const w = 1 / Math.max(c.d, 0.05) ** 2;
      num += w * c.v;
      den += w;
    }
    return num / den;
  }
}
