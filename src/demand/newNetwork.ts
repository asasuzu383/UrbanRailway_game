/**
 * 新線を加えたネットワークの一般化費用（docs/design.md §4.3, §4.5, §13）。
 * 既存駅間の値（ctx.times）は運行データから求めた一般化費用（乗車・待ち・乗換・徒歩）。新線は乗るたびに待ち時間を 1 回足す。
 *
 * 既存駅 o から新線の接続駅 k に乗るコスト board[k][o] = t_old(o, k) + τ（o が k 自身なら τ なし）。
 * これを使うと、新線経由の所要時間は
 *   既存→既存: via(o, d) = min_{k≠l} board[k][o] + T(k, l) + board[l][d]
 *   既存→新駅: min_k board[k][o] + T(k, n)
 * で求まる（T は新線上の乗車時間）。接続駅の数は少ないので、全駅の組でも十分速い。
 */
import { waitMinutes } from '../core/generalizedCost';
import type { DemandContext } from './context';
import type { LineStop } from './lineStops';

export class NewNetwork {
  readonly stops: readonly LineStop[];
  /** 接続駅（LineStop の添字） */
  readonly transferStops: readonly number[];
  /** 新駅（接続駅でない駅） */
  readonly freshStops: readonly number[];
  /** board[t][o]: 既存駅 o から transferStops[t] で新線に乗り換えるまでの一般化費用 [分]（既存線の一般化費用＋乗換抵抗。新線の待ち時間は含まない） */
  readonly board: readonly Float64Array[];
  /** 既存駅 o から最も早く新線に乗れる時間 */
  readonly minBoard: Float64Array;
  /** 新線に乗るときの待ち時間の一般化費用 [分]（待ち時間の重み × 待ち時間。新線の代表本数から） */
  readonly boardingWait: number;
  private readonly minutesPerKm: number;

  constructor(ctx: DemandContext, stops: readonly LineStop[]) {
    this.stops = stops;
    this.transferStops = stops.flatMap((s, i) => (s.existing !== null ? [i] : []));
    this.freshStops = stops.flatMap((s, i) => (s.existing === null ? [i] : []));
    this.minutesPerKm = 60 / ctx.params.service.scheduledSpeedKmh;
    const w = ctx.params.generalizedCost;
    this.boardingWait = w.waitWeight * waitMinutes(ctx.params.service.representativeTph, w);
    const tau = ctx.params.network.transferOtherOperatorMin;
    const n = ctx.stations.n;
    this.minBoard = new Float64Array(n).fill(Infinity);
    this.board = this.transferStops.map((k) => {
      const e = stops[k]!.existing!;
      const row = ctx.times.row(e);
      for (let o = 0; o < n; o++) {
        if (o !== e) row[o] = row[o]! + tau;
        if (row[o]! < this.minBoard[o]!) this.minBoard[o] = row[o]!;
      }
      return row;
    });
  }

  /** 新線の駅どうしの一般化費用 [分]（新線の待ち時間＋乗車時間） */
  freshToFresh(a: number, b: number): number {
    return this.boardingWait + this.lineTime(a, b);
  }

  /** 新線上の乗車時間 [分]（停車時間込みの表定速度） */
  lineTime(a: number, b: number): number {
    return Math.abs(this.stops[a]!.chainageKm - this.stops[b]!.chainageKm) * this.minutesPerKm;
  }

  /**
   * 既存駅 o から出発する経路の準備: 新線の各接続駅 l で降りるまでの最短時間と、そのとき乗る接続駅。
   * outTime[l] = min_{k≠l} board[k][o] + T(k, l)
   */
  outbound(o: number, outTime: Float64Array, outFrom: Int32Array): void {
    const nt = this.transferStops.length;
    for (let li = 0; li < nt; li++) {
      let best = Infinity;
      let arg = -1;
      for (let ki = 0; ki < nt; ki++) {
        if (ki === li) continue;
        const t = this.board[ki]![o]! + this.boardingWait + this.lineTime(this.transferStops[ki]!, this.transferStops[li]!);
        if (t < best) {
          best = t;
          arg = ki;
        }
      }
      outTime[li] = best;
      outFrom[li] = arg;
    }
  }

  /** 既存駅 o と新駅 n の間の最短時間と、その経路の接続駅（transferStops の添字） */
  toFresh(o: number, n: number): { time: number; via: number } {
    let best = Infinity;
    let arg = -1;
    this.transferStops.forEach((k, ki) => {
      const t = this.board[ki]![o]! + this.boardingWait + this.lineTime(k, n);
      if (t < best) {
        best = t;
        arg = ki;
      }
    });
    return { time: best, via: arg };
  }
}
