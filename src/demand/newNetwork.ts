/**
 * 新線を加えたネットワークの一般化費用（docs/design.md §4.3, §4.5, §13, §14）。
 * 既存駅間の値（ctx.times）は運行データから求めた一般化費用（乗車・待ち・乗換・徒歩）。
 * 新線上の駅の組の費用 C(k, l) は運行（lineOperation.ts）から: 両方に停まる種別の待ち時間＋乗車時間。
 *
 * 既存駅 o から新線の接続駅 k に乗り換えるコスト board[k][o] = t_old(o, k) + τ（o が k 自身なら τ なし）。
 * 直通運転の接続駅では、直通先の系統の駅 d' まで乗換・待ちなしで行けるので
 *   board[k][o] = min(t_old(o, k) + τ, min_{d'} ivt(k, d') + (d' = o ? 0 : τ + t_old(d', o)))
 * これを使うと、新線経由の費用は
 *   既存→既存: via(o, d) = min_{k≠l} board[k][o] + C(k, l) + board[l][d]
 *   既存→新駅: min_k board[k][o] + C(k, n)
 * で求まる。接続駅の数は少ないので、全駅の組でも十分速い。
 */
import { onLineCost, uniformOperation, type LineOperation } from './lineOperation';
import type { DemandContext } from './context';
import type { LineStop } from './lineStops';

export class NewNetwork {
  readonly stops: readonly LineStop[];
  /** 接続駅（LineStop の添字） */
  readonly transferStops: readonly number[];
  /** 新駅（接続駅でない駅） */
  readonly freshStops: readonly number[];
  /** board[t][o]: 既存駅 o と transferStops[t] の間の一般化費用 [分]（既存線の一般化費用＋乗換抵抗。直通は乗換なし） */
  readonly board: readonly Float64Array[];
  /** 既存駅 o から最も早く新線に乗れる費用 */
  readonly minBoard: Float64Array;
  /** 新線上の駅の組の一般化費用 [分]（ns × ns） */
  private readonly cost: Float64Array;

  constructor(ctx: DemandContext, stops: readonly LineStop[], operation?: LineOperation) {
    this.stops = stops;
    this.transferStops = stops.flatMap((s, i) => (s.existing !== null ? [i] : []));
    this.freshStops = stops.flatMap((s, i) => (s.existing === null ? [i] : []));
    const op = operation ?? uniformOperation(stops, ctx.params.service.scheduledSpeedKmh, ctx.params.service.representativeTph);
    this.cost = onLineCost(op, stops.length, ctx.params.generalizedCost);
    const tau = ctx.params.network.transferOtherOperatorMin;
    const n = ctx.stations.n;
    this.minBoard = new Float64Array(n).fill(Infinity);
    this.board = this.transferStops.map((k) => {
      const e = stops[k]!.existing!;
      const row = ctx.times.row(e);
      for (let o = 0; o < n; o++) if (o !== e) row[o] = row[o]! + tau;
      for (const t of op.through) {
        if (t.stop !== k) continue;
        // 直通: 直通先の系統の駅 d' まで乗換・待ちなし。その先は乗換（τ）して既存線
        for (const [dp, ivt] of t.ivtTo) {
          if (ivt < row[dp]!) row[dp] = ivt;
          for (let o = 0; o < n; o++) {
            if (o === dp) continue;
            const c = ivt + tau + ctx.times.get(dp, o);
            if (c < row[o]!) row[o] = c;
          }
        }
      }
      for (let o = 0; o < n; o++) if (row[o]! < this.minBoard[o]!) this.minBoard[o] = row[o]!;
      return row;
    });
  }

  /** 新線上の駅 a と b の一般化費用 [分]（待ち時間＋乗車時間。両方に停まる種別がなければ Infinity） */
  lineCost(a: number, b: number): number {
    return this.cost[a * this.stops.length + b]!;
  }

  /** 新線の駅どうしの一般化費用 [分] */
  freshToFresh(a: number, b: number): number {
    return this.lineCost(a, b);
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
        const t = this.board[ki]![o]! + this.lineCost(this.transferStops[ki]!, this.transferStops[li]!);
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
      const t = this.board[ki]![o]! + this.lineCost(k, n);
      if (t < best) {
        best = t;
        arg = ki;
      }
    });
    return { time: best, via: arg };
  }
}
