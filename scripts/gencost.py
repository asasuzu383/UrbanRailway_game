"""一般化費用（Phase 2 M2。docs/design.md §13）。

既存ネットワークの運行データ（public/data/<地域>/services.json）から「駅 × 運行系統 × 種別」のグラフを作り、
全駅間の一般化費用と、その内訳（乗車・待ち・乗換・徒歩）を求める。ブラウザ側の src/core/generalizedCost.ts と同じ式。

  一般化費用 [分] = 乗車時間 + w_wait × 待ち時間 + 乗換抵抗 + w_walk × 徒歩時間
  待ち時間 = min(60 / 代表本数 / 2, 上限)、代表本数 = ピーク × peak_share + 日中 × (1 − peak_share)

グラフ:
  S(駅) ─(τ_other−τ_same)/2─ O(駅, 事業者) ─τ_same/2＋w_wait×待ち─▶ V(系統, 種別, 停車位置)  … 乗車
  V ─τ_same/2─▶ O ─(τ_other−τ_same)/2─ S                                                      … 降車
  V(…, k) ─乗車時間─ V(…, k+1)                                                                … 乗車中
  V(系統A, *, 接続駅) ─0─ V(系統B, *, 接続駅)                                                  … 直通（乗換・待ちなし）
  S ─徒歩時間─ S                                                                             … 名前の異なる近接駅の徒歩乗換
同じ事業者の系統どうしの乗換は τ_same、他事業者とは τ_other。出発駅・到着駅でも乗車・降車の抵抗が 1 回ずつ
（合計 τ_other）かかるので、最後に差し引く。初めの乗車の待ち時間は差し引かない（実際に待つため）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

COMPONENTS = ["inVehicle", "wait", "transfer", "walk"]


def representative_tph(tph: dict, peak_share: float) -> float:
    return tph["peak"] * peak_share + tph["offpeak"] * (1 - peak_share)


def wait_minutes(tph: float, max_wait_min: float) -> float:
    """待ち時間 [分] = min(運行間隔 / 2, 上限)。本数 0 は上限"""
    if not tph > 0:
        return max_wait_min
    return min(60.0 / tph / 2.0, max_wait_min)


def generalized_minutes(c: dict, gcfg: dict) -> float:
    """内訳（乗車・待ち・乗換・徒歩 [分]）から一般化費用 [分]"""
    return c["inVehicle"] + gcfg["wait_weight"] * c["wait"] + c["transfer"] + gcfg["walk_weight"] * c["walk"]


@dataclass
class ServiceGraph:
    n_stations: int
    total: np.ndarray           # 辺の一般化費用の重み
    comp: dict                  # 内訳ごとの重み（同じ辺の並び）: inVehicle, wait（重み前）, transfer, walk（重み前）
    rows: np.ndarray
    cols: np.ndarray
    offset: float               # 出発・到着での乗車・降車の抵抗（最後に差し引く）
    n_nodes: int


def build_graph(services: dict, stations: list, net: dict, dcfg: dict) -> ServiceGraph:
    ncfg, gcfg = dcfg["network"], dcfg["generalized_cost"]
    t_same, t_other = ncfg["transfer_same_operator_min"], ncfg["transfer_other_operator_min"]
    n = len(stations)
    ids: dict[tuple, int] = {}

    def node(key: tuple) -> int:
        if key not in ids:
            ids[key] = n + len(ids)
        return ids[key]

    edges: dict[tuple[int, int], tuple] = {}  # (a, b) -> (total, inVehicle, wait, transfer, walk)。同じ組は小さい方

    def edge(a: int, b: int, ivt=0.0, wait=0.0, transfer=0.0, walk=0.0) -> None:
        total = max(ivt + gcfg["wait_weight"] * wait + transfer + gcfg["walk_weight"] * walk, 1e-6)
        if (a, b) not in edges or total < edges[(a, b)][0]:
            edges[(a, b)] = (total, ivt, wait, transfer, walk)

    half = (t_other - t_same) / 2
    ops_at = set()
    for r in services["routes"]:
        op = r["operator"]
        for si, s in enumerate(r["services"]):
            w = wait_minutes(representative_tph(s["tph"], gcfg["peak_share"]), gcfg["max_wait_min"])
            for k, pos in enumerate(s["stops"]):
                st = r["stations"][pos]
                v = node(("V", r["id"], si, pos))
                o = node(("O", st, op))
                ops_at.add((st, op))
                edge(o, v, wait=w, transfer=t_same / 2)   # 乗車
                edge(v, o, transfer=t_same / 2)           # 降車
                if k + 1 < len(s["stops"]):
                    v2 = node(("V", r["id"], si, s["stops"][k + 1]))
                    m = s["legMinutes"][k]
                    if m is not None:
                        edge(v, v2, ivt=m)
                        edge(v2, v, ivt=m)
    for st, op in ops_at:
        o = ids[("O", st, op)]
        edge(st, o, transfer=half)
        edge(o, st, transfer=half)
    # 直通: 接続駅で両系統の全種別を乗換なしで結ぶ
    by_id = {r["id"]: r for r in services["routes"]}
    for r in services["routes"]:
        for t in r.get("through", []):
            other = by_id.get(t.get("route"))
            if other is None:
                continue
            for st in t["at"]:
                for si, s in enumerate(r["services"]):
                    pa = [p for p in s["stops"] if r["stations"][p] == st]
                    for sj, s2 in enumerate(other["services"]):
                        pb = [p for p in s2["stops"] if other["stations"][p] == st]
                        for a in pa:
                            for b in pb:
                                va, vb = node(("V", r["id"], si, a)), node(("V", other["id"], sj, b))
                                edge(va, vb)
                                edge(vb, va)
    for a, b, d_m in net["walk"]:
        mins = d_m * ncfg["walk_detour_factor"] / 1000 / ncfg["walk_speed_kmh"] * 60
        edge(a, b, walk=mins)
        edge(b, a, walk=mins)

    size = n + len(ids)
    keys = list(edges)
    vals = np.array([edges[k] for k in keys])
    rows_a = np.array([k[0] for k in keys])
    cols_a = np.array([k[1] for k in keys])
    comp = {k: vals[:, i + 1] for i, k in enumerate(COMPONENTS)}
    return ServiceGraph(n, vals[:, 0], comp, rows_a, cols_a, t_other, size)


def _run(g: ServiceGraph, weights: np.ndarray, sources: np.ndarray) -> np.ndarray:
    m = coo_matrix((weights, (g.rows, g.cols)), shape=(g.n_nodes, g.n_nodes)).tocsr()
    return dijkstra(m, directed=True, indices=sources)[:, : g.n_stations]


def generalized_cost_matrix(g: ServiceGraph, breakdown: bool = False, eps: float = 1e-4) -> tuple[np.ndarray, dict]:
    """全駅間の一般化費用 [分]（到達不能は inf）。breakdown=True なら内訳も返す。

    内訳は、一般化費用の重みに各内訳を eps 倍して足したグラフで最短距離を求め直し、距離の増分 / eps で求める
    （経路が変わらない程度に小さい摂動。同じ費用の経路が複数あるときはどちらかの内訳になる）。"""
    src = np.arange(g.n_stations)
    base_w = g.total
    dist = _run(g, base_w, src)
    total = np.maximum(dist - g.offset, 0)
    np.fill_diagonal(total, 0)
    comps = {}
    if breakdown:
        for k in COMPONENTS:
            d2 = _run(g, base_w + eps * g.comp[k], src)
            with np.errstate(invalid="ignore"):
                v = (d2 - dist) / eps
            if k == "transfer":
                v = v - g.offset
            v = np.where(np.isfinite(dist), np.maximum(v, 0), np.inf)
            np.fill_diagonal(v, 0)
            comps[k] = v
    return total, comps
