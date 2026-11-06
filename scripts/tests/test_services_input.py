"""scripts/06_services.py の手入力テンプレートの扱いと品質フラグの単体テスト（小さな直線の路線で確かめる）。

    .venv\\Scripts\\python.exe scripts\\tests\\test_services_input.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
_spec = importlib.util.spec_from_file_location("services06", HERE.parent / "06_services.py")
svc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(svc)

# A〜D の 4 駅が 2km 間隔で並ぶ 1 本の線（民営）
STATIONS = [{"name": n, "lines": [0], "lng": 139.0 + i * 0.02, "lat": 35.0, "inRegion": 1} for i, n in enumerate("ABCD")]
NET = {"lines": [{"name": "本線", "operator": "X鉄道", "operatorType": 4, "railType": 12, "speedKmh": 35.0}],
       "edges": [[0, 1, 0, 2000.0], [1, 2, 0, 2000.0], [2, 3, 0, 2000.0]]}
SCFG = {
    "runtime": {"accel_kmh_per_s": 3.0, "decel_kmh_per_s": 3.5, "dwell_s": 30, "dwell_major_s": 50, "margin": 1.15,
                "default_max_speed_kmh": {"rail_type": {}, "operator_type": {"4": 100}, "default": 100}},
    "provisional": {"offpeak_ratio": 0.5, "tph_by_operator_type": {"4": {"peak": 12, "offpeak": 6}}, "tph_by_rail_type": {}},
    "mlit_peak": {"lines": {"X鉄道/本線": {"tph": 20, "cars": 8, "section": "C→D"}}},
    "routes": [],
}


def base_route(**kw) -> dict:
    r = {"id": "x_main", "name": "本線", "operator": "X鉄道", "lines": ["X鉄道/本線"], "from": "A", "to": "D",
         "max_speed_kmh": None, "max_speed_source": None, "peak": {"mlit_line": "X鉄道/本線"},
         "services": [{"name": "各停", "stops": "all", "tph_peak": None, "offpeak_tph": None}], "source": "テスト資料"}
    r.update(kw)
    return r


def run(routes: list, overrides: dict | None = None, scfg_routes: list | None = None):
    scfg = dict(SCFG)
    scfg["routes"] = scfg_routes or []
    scfg["input"] = {"routes": routes, "route_overrides": overrides or {}}
    return svc.configured_routes(scfg, svc.Network(STATIONS, NET))


def test_incomplete_route_is_skipped() -> None:
    out, skipped = run([base_route(source=None), base_route(id="y", services=[{"name": "急行", "stops": None}])])
    assert out == []
    assert [s["id"] for s in skipped] == ["x_main", "y"]
    assert "source" in skipped[0]["missing"]


def test_estimated_with_defaults() -> None:
    out, _ = run([base_route()])
    r = out[0]
    d = r["qualityDetail"]
    assert r["quality"] == "estimated"
    # 最高速度は既定値（仮置き）、本数はピーク = 国交省、日中 = ピークの比率（仮置き）
    assert (d["stops"], d["runTime"], d["maxSpeed"], d["peak"], d["offpeak"]) == ("published", "estimated", "provisional", "published", "provisional")
    assert r["services"][0]["tph"] == {"peak": 20.0, "offpeak": 10.0}
    assert len(r["services"][0]["legMinutes"]) == 3


def test_published_inputs_upgrade_items() -> None:
    sv = [{"name": "各停", "stops": "all", "tph_peak": 14, "offpeak_tph": 8},
          {"name": "急行", "stops": ["A", "D"], "tph_peak": 6, "offpeak_tph": 4, "minutes": [0, 7]}]
    out, _ = run([base_route(max_speed_kmh=110, max_speed_source="テスト資料", services=sv)])
    r = out[0]
    d = r["qualityDetail"]
    # 種別の 1 つが物理推定なので、系統の所要時間の品質は低い方の物理推定
    assert r["quality"] == "estimated"
    assert (d["maxSpeed"], d["peak"], d["offpeak"]) == ("published", "published", "published")
    assert r["services"][1]["legMinutes"] == [7.0]


def test_all_minutes_given_is_published() -> None:
    sv = [{"name": "各停", "stops": "all", "minutes": [0, 3, 6, 9]}]
    out, _ = run([base_route(services=sv)])
    assert out[0]["quality"] == "published"
    assert out[0]["qualityDetail"]["maxSpeed"] is None


def test_override_on_services_yaml_route() -> None:
    jr = base_route(id="jr_x", max_speed_kmh=90)
    del jr["max_speed_source"]
    out, _ = run([], overrides={"jr_x": {"max_speed_kmh": None, "max_speed_source": None, "services": {"各停": {"offpeak_tph": None}}}},
                 scfg_routes=[jr])
    assert out[0]["qualityDetail"]["maxSpeed"] == "provisional"  # null の上書きは無視
    out, _ = run([], overrides={"jr_x": {"max_speed_kmh": 120, "max_speed_source": "資料", "services": {"各停": {"offpeak_tph": 9}}}},
                 scfg_routes=[jr])
    d = out[0]["qualityDetail"]
    assert out[0]["maxSpeedKmh"] == 120
    assert (d["maxSpeed"], d["offpeak"]) == ("published", "published")
    assert out[0]["services"][0]["tph"]["offpeak"] == 9.0


def test_faster_max_speed_is_not_slower() -> None:
    slow, _ = run([base_route(max_speed_kmh=60, max_speed_source="s")])
    fast, _ = run([base_route(max_speed_kmh=120, max_speed_source="s")])
    assert sum(fast[0]["services"][0]["legMinutes"]) < sum(slow[0]["services"][0]["legMinutes"])


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            n += 1
    print(f"ok ({n} tests)")
