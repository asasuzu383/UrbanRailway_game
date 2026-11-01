/**
 * 既存駅間の最短所要時間（分, 整数）。scripts/calibrate.py が times.bin として書き出す。
 * 形式: 上三角（i < j）を行優先で並べた Uint8Array。255 は到達不能（または 255 分以上）。
 */
export const UNREACHABLE = 255;

export class TimeMatrix {
  readonly n: number;
  private readonly data: Uint8Array;

  constructor(n: number, data: Uint8Array) {
    const expected = (n * (n - 1)) / 2;
    if (data.length !== expected) throw new Error(`times.bin の長さ ${data.length} が駅数 ${n} と合いません（期待値 ${expected}）`);
    this.n = n;
    this.data = data;
  }

  /** 所要時間 [分]。到達不能は Infinity */
  get(i: number, j: number): number {
    if (i === j) return 0;
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const v = this.data[a * this.n - (a * (a + 1)) / 2 + (b - a - 1)]!;
    return v === UNREACHABLE ? Infinity : v;
  }

  /** 駅 i から全駅への所要時間（行を取り出す。繰り返し参照するループ用） */
  row(i: number, out: Float64Array = new Float64Array(this.n)): Float64Array {
    for (let j = 0; j < this.n; j++) out[j] = this.get(i, j);
    return out;
  }
}

/** テスト・Python との受け渡し用: 対称行列から上三角の Uint8Array を作る */
export function encodeUpperTriangle(times: readonly (readonly number[])[]): Uint8Array {
  const n = times.length;
  const out = new Uint8Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = times[i]![j]!;
      out[k++] = Number.isFinite(t) ? Math.min(254, Math.round(t)) : UNREACHABLE;
    }
  }
  return out;
}
