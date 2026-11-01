/**
 * 点の格子インデックス（緯度経度のまま扱う。首都圏スケールでは十分）。
 * radiusKm 以内の候補を返すが、正確な距離判定は呼び出し側で行う。
 */
export class GridIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly cellDeg: number;

  constructor(lngs: ArrayLike<number>, lats: ArrayLike<number>, cellDeg = 0.02) {
    this.cellDeg = cellDeg;
    for (let i = 0; i < lngs.length; i++) {
      const key = this.key(Math.floor(lngs[i]! / cellDeg), Math.floor(lats[i]! / cellDeg));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
  }

  private key(cx: number, cy: number): number {
    return cx * 100_000 + cy;
  }

  /** (lng, lat) から radiusKm 以内にある可能性のある点の添字 */
  near(lng: number, lat: number, radiusKm: number): number[] {
    const dLat = radiusKm / 111.0;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    const x0 = Math.floor((lng - dLng) / this.cellDeg);
    const x1 = Math.floor((lng + dLng) / this.cellDeg);
    const y0 = Math.floor((lat - dLat) / this.cellDeg);
    const y1 = Math.floor((lat + dLat) / this.cellDeg);
    const out: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (list) out.push(...list);
      }
    }
    return out;
  }
}
