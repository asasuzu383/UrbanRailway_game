"""scripts/gencost.py の単体テスト（小さなネットワークで内訳を確かめる）。

    .venv\\Scripts\\python.exe scripts\\tests\\test_gencost.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import gencost  # noqa: E402

DCFG = {
    "network": {"transfer_same_operator_min": 3, "transfer_other_operator_min": 8, "walk_speed_kmh": 4.8, "walk_detour_factor": 1.3},
    "generalized_cost": {"wait_weight": 1.5, "max_wait_min": 15, "peak_share": 0.5, "walk_weight": 1.0},
}
STATIONS = [{"name": n} for n in "ABCDE"]
NET = {"walk": [[3, 4, 120]]}  # D〜E は徒歩 120m


def route(rid, op, stations, legs, tph, through=None):
    return {"id": rid, "operator": op, "stations": stations, "through": through or [],
            "services": [{"name": "各停", "stops": list(range(len(stations))), "legMinutes": legs, "tph": {"peak": tph, "offpeak": tph}}]}


def matrix(services):
    g = gencost.build_graph({"routes": services}, STATIONS, NET, DCFG)
    return gencost.generalized_cost_matrix(g, breakdown=True)


def test_single_ride() -> None:
    tot, c = matrix([route("r1", "X", [0, 1, 2], [5, 7], 12)])
    # A→C: 乗車 12 分 + 待ち 2.5 分 × 1.5
    assert abs(tot[0, 2] - (12 + 1.5 * 2.5)) < 1e-6, tot[0, 2]
    assert abs(c["inVehicle"][0, 2] - 12) < 1e-3 and abs(c["wait"][0, 2] - 2.5) < 1e-3 and c["transfer"][0, 2] < 1e-3


def test_transfer_and_through() -> None:
    r1 = route("r1", "X", [0, 1], [5], 12)
    r2 = route("r2", "Y", [1, 2], [6], 6)
    tot, c = matrix([r1, r2])
    # 他事業者への乗換: 乗換抵抗 8 分 + 2 回目の待ち 5 分
    assert abs(c["transfer"][0, 2] - 8) < 1e-3, c["transfer"][0, 2]
    assert abs(c["wait"][0, 2] - (2.5 + 5)) < 1e-3
    assert abs(tot[0, 2] - (11 + 1.5 * 7.5 + 8)) < 1e-6
    # 直通運転なら乗換抵抗・2 回目の待ちとも 0
    r1t = {**r1, "through": [{"route": "r2", "at": [1]}]}
    tot2, c2 = matrix([r1t, r2])
    assert c2["transfer"][0, 2] < 1e-3 and abs(c2["wait"][0, 2] - 2.5) < 1e-3, (c2["transfer"][0, 2], c2["wait"][0, 2])
    assert abs(tot2[0, 2] - (11 + 1.5 * 2.5)) < 1e-6


def test_same_operator_transfer_and_walk() -> None:
    r1 = route("r1", "X", [0, 1], [5], 12)
    r2 = route("r2", "X", [1, 3], [4], 12)
    tot, c = matrix([r1, r2])
    assert abs(c["transfer"][0, 3] - 3) < 1e-3  # 同一事業者の乗換は 3 分
    walk_min = 120 * 1.3 / 1000 / 4.8 * 60
    assert abs(c["walk"][0, 4] - walk_min) < 1e-3
    assert abs(tot[0, 4] - (tot[0, 3] + walk_min)) < 1e-6


def test_wait_cap() -> None:
    assert gencost.wait_minutes(1, 15) == 15
    assert gencost.wait_minutes(0, 15) == 15
    assert abs(gencost.wait_minutes(12, 15) - 2.5) < 1e-9
    assert np.isclose(gencost.generalized_minutes({"inVehicle": 10, "wait": 2, "transfer": 3, "walk": 1}, DCFG["generalized_cost"]), 10 + 3 + 3 + 1)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
