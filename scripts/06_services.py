"""既存ネットワークの運行データ（運行系統・種別・停車駅・駅間所要時間・時間帯別本数・直通）を作る（Phase 2 M1）。

入力:
  scripts/config/regions/<地域>/services.yaml   公表資料ベースの系統、ODPT・計算・仮置きの設定
  data/raw/odpt/                 ODPT の時刻表（scripts/odpt_download.py）
  public/data/<地域>/stations.json, network.json
出力:
  public/data/<地域>/services.json      運行系統（docs/design.md §11）
  scripts/config/regions/<地域>/services_input.yaml  手入力テンプレート（公表資料の停車駅・最高速度・日中本数・所要時間）
  docs/services_coverage.md      路線ごとのデータ品質（時刻表／公表資料／物理推定／仮置き）の内訳と物理推定の検証
  docs/services_input_priority.md  手入力をお願いしたい線・系統の優先順

時刻表ベースの系統は、種別ごとの駅間所要時間の中央値と時間あたり本数に集計した値だけを書き出す
（元の時刻表は復元できない。公共交通オープンデータ基本ライセンス第8条4項への対応）。
"""

from __future__ import annotations

import datetime as dt
import heapq
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import yaml

from common import INTERIM, PUBLIC_DATA, RAW, docs_path, region_config_path, write_json

HERE = Path(__file__).resolve().parent
ODPT_DIR = RAW / "odpt"
# 品質フラグ（所要時間の出所。この順に高い）: 時刻表ベース／公表資料／物理推定（入力値）／物理推定（既定値）／仮置き
#   estimated         … 公表資料の停車駅と最高速度（手入力）から運転曲線で計算
#   estimated_default … 停車駅（優等列車のパターン）か最高速度のどちらかが既定値（各停は全駅停車、最高速度は路線タイプ別の既定値）
QUALITIES = ["timetable", "published", "estimated", "estimated_default", "provisional"]
QUALITY_LABEL = {"timetable": "時刻表", "published": "公表資料", "estimated": "物理推定（入力値）",
                 "estimated_default": "物理推定（既定値）", "provisional": "仮置き"}
# 項目ごとの品質（qualityDetail）
ITEMS = ["stops", "runTime", "maxSpeed", "peak", "offpeak"]
ITEM_LABEL = {"stops": "停車駅", "runTime": "所要時間", "maxSpeed": "最高速度", "peak": "ピーク本数", "offpeak": "日中本数"}
# 手入力テンプレート（地域の設定ディレクトリ）。公表資料から手で入れる値（停車駅・最高速度・日中本数・公表の所要時間）
INPUT_FILE = "services_input.yaml"


def load_services_config() -> dict:
    with region_config_path("services.yaml").open(encoding="utf-8") as f:
        scfg = yaml.safe_load(f)
    p = region_config_path(INPUT_FILE)
    scfg["input"] = (yaml.safe_load(p.read_text(encoding="utf-8")) or {}) if p.exists() else {}
    return scfg


def haversine_m(lng1, lat1, lng2, lat2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, h)))


class Network:
    """network.json の隣接駅エッジ（路線ごと）"""

    def __init__(self, stations: list, net: dict) -> None:
        self.stations = stations
        self.lines = net["lines"]
        self.edges = net["edges"]  # [a, b, line, length_m]
        self.adj: dict[int, list[tuple[int, int, float, int]]] = defaultdict(list)  # a -> (b, line, len, edge idx)
        for ei, (a, b, li, d) in enumerate(self.edges):
            self.adj[a].append((b, li, d, ei))
            self.adj[b].append((a, li, d, ei))
        self.line_key = {f"{l['operator']}/{l['name']}": i for i, l in enumerate(self.lines)}

    def edges_between(self, a: int, b: int, operator: str | None = None, lines: set | None = None) -> list[int]:
        return [ei for (n, li, _, ei) in self.adj[a] if n == b
                and (operator is None or self.lines[li]["operator"] == operator)
                and (lines is None or li in lines)]

    def path(self, a: int, b: int, lines: set | None = None, operator: str | None = None,
             prefer_stations: bool = False) -> list[int] | None:
        """駅 a から b までの最短経路（駅の並び）。lines / operator で使う線を制限する。
        prefer_stations: 各駅停車の系統用。エッジの重みを（延長 − 300m）にして、同じくらいの延長なら途中駅の多い経路
        （緩行線）を選ぶ（N02 の法令上の線には快速線と緩行線が同じ線名で入っているため）"""
        dist = {a: 0.0}
        prev: dict[int, int] = {}
        heap = [(0.0, a)]
        while heap:
            d, n = heapq.heappop(heap)
            if n == b:
                break
            if d > dist.get(n, math.inf):
                continue
            for m, li, w, _ in self.adj[n]:
                if lines is not None and li not in lines:
                    continue
                if operator is not None and self.lines[li]["operator"] != operator:
                    continue
                nd = d + (max(w - 300.0, 10.0) if prefer_stations else w)
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    prev[m] = n
                    heapq.heappush(heap, (nd, m))
        if b not in dist:
            return None
        seq = [b]
        while seq[-1] != a:
            seq.append(prev[seq[-1]])
        return seq[::-1]

    def leg_length(self, a: int, b: int, lines: set | None = None, operator: str | None = None) -> tuple[float, list[int]]:
        """隣接駅（または経路）の線路延長 [m] と使ったエッジ"""
        seq = self.path(a, b, lines, operator)
        if seq is None:
            return math.nan, []
        total, used = 0.0, []
        for u, v in zip(seq[:-1], seq[1:]):
            cands = [(self.edges[ei][3], ei) for (n, li, _, ei) in self.adj[u] if n == v
                     and (lines is None or li in lines) and (operator is None or self.lines[li]["operator"] == operator)]
            d, ei = min(cands)
            total += d
            used.append(ei)
        return total, used


# ---------------------------------------------------------------------------
# 運転曲線の簡易計算
# ---------------------------------------------------------------------------

def run_seconds(dist_m: float, vmax_kmh: float, accel_kmh_s: float, decel_kmh_s: float) -> float:
    """駅間の走行時間 [s]（停車時間を除く）。加速 → 最高速度 → 減速の台形、届かなければ三角形。"""
    v = vmax_kmh / 3.6
    a = accel_kmh_s / 3.6
    b = decel_kmh_s / 3.6
    d_ab = v * v / (2 * a) + v * v / (2 * b)
    if dist_m >= d_ab:
        return v / a + v / b + (dist_m - d_ab) / v
    vp = math.sqrt(2 * dist_m * a * b / (a + b))
    return vp / a + vp / b


# ---------------------------------------------------------------------------
# 時刻表ベース（ODPT）
# ---------------------------------------------------------------------------

def load_odpt(kind: str) -> list:
    items = []
    p = ODPT_DIR / f"public_{kind}.json"
    if p.exists():
        items += json.loads(p.read_text(encoding="utf-8"))
    for q in sorted(ODPT_DIR.glob(f"key_*_{kind}.json")):
        items += json.loads(q.read_text(encoding="utf-8"))
    return items


def minutes(t: str) -> int:
    h, m = map(int, t.split(":"))
    return (h if h >= 3 else h + 24) * 60 + m  # 0〜2 時台は前日の続き


def match_odpt_stations(odpt_stations: list, stations: list) -> dict[str, int]:
    """ODPT の駅 → 駅グループ（同名で 600m 以内、無ければ 300m 以内の最寄り）"""
    by_name = defaultdict(list)
    for i, s in enumerate(stations):
        by_name[s["name"]].append(i)
    lng = np.array([s["lng"] for s in stations])
    lat = np.array([s["lat"] for s in stations])
    out = {}
    for s in odpt_stations:
        if "geo:lat" not in s:
            continue
        name = s.get("dc:title", "")
        cands = [(haversine_m(s["geo:long"], s["geo:lat"], stations[i]["lng"], stations[i]["lat"]), i) for i in by_name.get(name, [])]
        cands = [c for c in cands if c[0] <= 600]
        if cands:
            out[s["owl:sameAs"]] = min(cands)[1]
            continue
        d = np.hypot((lng - s["geo:long"]) * 91000, (lat - s["geo:lat"]) * 111000)
        j = int(np.argmin(d))
        if d[j] <= 300:
            out[s["owl:sameAs"]] = j
    return out


def odpt_routes(scfg: dict, nw: Network) -> tuple[list, dict]:
    ocfg = scfg["odpt"]
    railways = load_odpt("Railway")
    trains = [t for t in load_odpt("TrainTimetable") if t.get("odpt:calendar") == ocfg["calendar"]]
    st_map = match_odpt_stations(load_odpt("Station"), nw.stations)
    types = {t["owl:sameAs"]: t.get("dc:title", t["owl:sameAs"].split(".")[-1]) for t in load_odpt("TrainType")}
    op_names = ocfg["operator_names"]
    by_rail = defaultdict(list)
    for t in trains:
        by_rail[t["odpt:railway"]].append(t)
    # ダイヤの版（時刻表データの発行日 dct:issued の最大）
    issued = defaultdict(str)
    for t in trains:
        issued[t["odpt:railway"]] = max(issued[t["odpt:railway"]], t.get("dct:issued", ""))
    routes, report = [], {}
    for rw in railways:
        rid = rw["owl:sameAs"]
        op = rid.split(":")[1].split(".")[0]
        if op not in ocfg["operators"] or rid not in by_rail:
            continue
        operator = op_names[op]
        order = [o["odpt:station"] for o in sorted(rw.get("odpt:stationOrder", []), key=lambda o: o["odpt:index"])]
        unmatched = [o for o in order if o not in st_map]
        order = [o for o in order if o in st_map]
        idx = [st_map[o] for o in order]
        pos = {o: k for k, o in enumerate(order)}
        # 種別ごとの停車・通過の集計
        per_type: dict[str, list] = defaultdict(list)
        for t in by_rail[rid]:
            stops = []
            for obj in t.get("odpt:trainTimetableObject", []):
                s = obj.get("odpt:departureStation") or obj.get("odpt:arrivalStation")
                tm = obj.get("odpt:departureTime") or obj.get("odpt:arrivalTime")
                if s in pos and tm:
                    stops.append((pos[s], minutes(tm)))
            if len(stops) >= 2:
                per_type[t.get("odpt:trainType", "?")].append((t, stops))
        services = []
        throughs = Counter()
        total = defaultdict(lambda: defaultdict(int))  # 全種別: (方向, 駅) -> 時 -> 本数
        for t, stops in (x for v in per_type.values() for x in v):
            for k, m in stops:
                total[(t.get("odpt:railDirection", ""), k)][(m // 60) % 24] += 1
        peak_total = max((max(c.get(h, 0) for h in ocfg["peak_hours"]) for c in total.values()), default=0)
        for ttype, items in per_type.items():
            n = len(order)
            covered = np.zeros(n)
            stopped = np.zeros(n)
            for _, stops in items:
                ks = [k for k, _ in stops]
                covered[min(ks):max(ks) + 1] += 1
                for k in ks:
                    stopped[k] += 1
            span = covered >= 0.3 * len(items)
            pattern = [k for k in range(n) if span[k] and covered[k] > 0 and stopped[k] / covered[k] >= ocfg["stop_share"]]
            if len(pattern) < 2:
                continue
            legs = defaultdict(list)
            dep = defaultdict(lambda: defaultdict(int))  # (direction, station) -> hour -> count
            for t, stops in items:
                ks = {k: m for k, m in stops}
                for a, b in zip(pattern[:-1], pattern[1:]):
                    if a in ks and b in ks:
                        legs[(a, b)].append(abs(ks[b] - ks[a]))
                direction = t.get("odpt:railDirection", "")
                for k, m in stops:
                    dep[(direction, k)][(m // 60) % 24] += 1
                for key, at in (("odpt:destinationStation", stops[-1][0]), ("odpt:originStation", stops[0][0])):
                    for s in t.get(key, []) or []:
                        other = s.split(":")[1].split(".")[0]
                        if s.split(":")[1].rsplit(".", 1)[0] != rid.split(":")[1]:
                            throughs[(op_names.get(other, other), at)] += 1
            leg_min = []
            for a, b in zip(pattern[:-1], pattern[1:]):
                v = legs.get((a, b))
                leg_min.append(float(np.median(v)) if v else None)
            peak = max((max(c.get(h, 0) for h in ocfg["peak_hours"]) for c in dep.values()), default=0)
            off = max((np.mean([c.get(h, 0) for h in ocfg["offpeak_hours"]]) for c in dep.values()), default=0)
            if max(peak, off) < 1:
                continue  # 1 時間に 1 本未満の種別は除く
            services.append({"name": types.get(ttype, ttype.split(".")[-1]), "stops": pattern, "legMinutes": leg_min,
                             "tph": {"peak": int(peak), "offpeak": round(float(off), 1)}, "trains": len(items)})
        if not services:
            continue
        services.sort(key=lambda s: -s["trains"])
        n_tr = len(by_rail[rid])
        routes.append({
            "id": f"odpt:{rid.split(':')[1]}", "name": rw.get("dc:title", rid), "operator": operator, "quality": "timetable",
            "source": f"ODPT {ocfg['operators'][op]['license']}（{rid}、平日、{issued[rid] or '発行日不明'} 発行のダイヤ）",
            "dataIssued": issued[rid] or None,
            "stations": idx, "cars": None, "peakTotalTph": int(peak_total),
            "throughRaw": [{"operator": o, "at": idx[k], "share": round(c / n_tr / 2, 3)} for (o, k), c in throughs.most_common()],
            "services": services,
        })
        report[rid] = {"stations": len(order), "unmatched": unmatched, "trains": n_tr}
    return routes, report


# ---------------------------------------------------------------------------
# 公表資料ベース
# ---------------------------------------------------------------------------

def station_on_lines(nw: Network, name: str, lines: set) -> int:
    cands = [i for i, s in enumerate(nw.stations) if s["name"] == name and set(s["lines"]) & lines]
    if not cands:
        raise SystemExit(f"駅「{name}」が線 {sorted(lines)} 上にありません")
    if len(cands) > 1:
        # 同名の駅グループが複数ある（例: 東京駅の京葉線ホーム）ときは、指定の線が多く乗り入れる方
        cands.sort(key=lambda i: -len(set(nw.stations[i]["lines"]) & lines))
        if len(set(nw.stations[cands[0]]["lines"]) & lines) == len(set(nw.stations[cands[1]]["lines"]) & lines):
            raise SystemExit(f"駅「{name}」が線 {sorted(lines)} 上に複数あり区別できません")
    return cands[0]


def route_lines(nw: Network, r: dict) -> set:
    """系統が走る N02 の線: lines（"運営会社/線名"）の指定、なければ operator の全線"""
    if r.get("lines"):
        out = set()
        for k in r["lines"]:
            if k not in nw.line_key:
                raise SystemExit(f"{r['id']}: network.json に線 {k} がありません")
            out.add(nw.line_key[k])
        return out
    return {i for i, l in enumerate(nw.lines) if l["operator"] == r["operator"]}


def route_sequence(nw: Network, r: dict, lines: set) -> list[int]:
    """系統の駅の並び。
    stations: 駅名の一覧（停車駅だけを並べた快速など。駅間の延長は線の上の最短経路）
    waypoints: 経由駅の一覧。各駅停車として駅の多い経路でつなぐ（from/to は waypoints の 2 駅の場合の略記）"""
    if r.get("stations"):
        # 同名の駅グループが複数ある駅（例: 武蔵小杉の横須賀線ホーム）は、前の駅から線路をたどって近い方を選ぶ
        names = r["stations"]
        cands = [[i for i, s in enumerate(nw.stations) if s["name"] == x and set(s["lines"]) & lines] for x in names]
        for x, c in zip(names, cands):
            if not c:
                raise SystemExit(f"{r['id']}: 駅「{x}」が線の上にありません")
        seq: list[int] = []
        for k, c in enumerate(cands):
            if len(c) == 1:
                seq.append(c[0])
                continue
            ref = seq[-1] if seq else next((cc[0] for cc in cands[k + 1:] if len(cc) == 1), None)
            if ref is None:
                seq.append(station_on_lines(nw, names[k], lines))
                continue
            seq.append(min(c, key=lambda i: nw.leg_length(ref, i, lines)[0]))
        return seq
    wps = r.get("waypoints") or [r["from"], r["to"]]
    pts = [station_on_lines(nw, x, lines) for x in wps]
    seq = [pts[0]]
    for u, v in zip(pts[:-1], pts[1:]):
        part = nw.path(u, v, lines, prefer_stations=True)
        if part is None:
            raise SystemExit(f"{r['id']}: {nw.stations[u]['name']} から {nw.stations[v]['name']} までつながっていません")
        seq.extend(part[1:])
    if len(set(seq)) != len(seq):
        raise SystemExit(f"{r['id']}: 経路が同じ駅を 2 回通ります（waypoints を見直す）: {[nw.stations[i]['name'] for i in seq]}")
    return seq


def default_max_speed(scfg: dict, line: dict) -> float:
    """最高速度が未入力のときの既定値（仮置き）: N02 の鉄道区分 → 事業者種別 → default の順"""
    d = scfg["runtime"]["default_max_speed_kmh"]
    return float((d.get("operator") or {}).get(line["operator"]) or d["rail_type"].get(str(line["railType"]))
                 or d["operator_type"].get(str(line["operatorType"])) or d["default"])


def leg_minutes(scfg: dict, nw: Network, dist_m: float, to_station: int, vmax: float) -> float:
    """1 駅間の所要時間 [分]（運転曲線の簡易計算 + 着駅の停車時間、× 余裕係数）"""
    rcfg = scfg["runtime"]
    dwell = rcfg["dwell_major_s"] if len(nw.stations[to_station]["lines"]) >= 2 else rcfg["dwell_s"]
    sec = (run_seconds(dist_m, vmax, rcfg["accel_kmh_per_s"], rcfg["decel_kmh_per_s"]) + dwell) * rcfg["margin"]
    return round(sec / 60, 2)


def kinematic_legs(scfg: dict, nw: Network, seq: list, stops: list, lines: set | None, vmax: float,
                   operator: str | None = None, label: str = "") -> list[float]:
    """停車駅間の所要時間 [分]（運転曲線の簡易計算 + 停車時間、× 余裕係数）"""
    legs = []
    for i, j in zip(stops[:-1], stops[1:]):
        dist, _ = nw.leg_length(seq[i], seq[j], lines, operator)
        if not math.isfinite(dist):
            raise SystemExit(f"{label}: {nw.stations[seq[i]]['name']}〜{nw.stations[seq[j]]['name']} の線路がつながっていません")
        legs.append(leg_minutes(scfg, nw, dist, seq[j], vmax))
    return legs


def worst(qs) -> str:
    """品質の一覧のうち最も低いもの"""
    qs = [q for q in qs if q]
    return max(qs, key=QUALITIES.index) if qs else "provisional"


def peak_of(scfg: dict, r: dict, nw: Network, lines: set) -> dict:
    """ピーク本数・編成と品質: peak に {tph, cars, source} を直接書くか、mlit_jr / mlit_line で国交省の値を引く。
    未入力（手入力テンプレートの系統）なら、走る線のどれかの国交省の値、無ければ仮置きの既定値"""
    pk = dict(r.get("peak") or {})
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    if pk.get("mlit_jr"):
        m = scfg["mlit_peak_jr"][pk["mlit_jr"]]
        return {"tph": m["tph"], "cars": m["cars"], "quality": "published", "source": f"国交省 混雑率データ（{pk['mlit_jr']} {m['section']}）"}
    if pk.get("mlit_line"):
        m = mlit[pk["mlit_line"]]
        return {"tph": m["tph"], "cars": m["cars"], "quality": "published", "source": f"国交省 混雑率データ（{m['section']}）"}
    if pk.get("tph") is not None:
        src = pk.get("source") or "仮置き"
        return {"tph": pk["tph"], "cars": pk.get("cars"), "quality": "provisional" if src == "仮置き" else "published", "source": src}
    for li in sorted(lines):
        key = f"{nw.lines[li]['operator']}/{nw.lines[li]['name']}"
        if key in mlit:
            m = mlit[key]
            return {"tph": m["tph"], "cars": pk.get("cars") or m["cars"], "quality": "published", "source": f"国交省 混雑率データ（{m['section']}）"}
    line = nw.lines[min(lines)]
    d = scfg["provisional"]["tph_by_operator_type"].get(str(line["operatorType"]), {"peak": 8})
    return {"tph": d["peak"], "cars": pk.get("cars"), "quality": "provisional", "source": "仮置き"}


# ---------------------------------------------------------------------------
# 手入力テンプレート（services_input.yaml）
# ---------------------------------------------------------------------------

def missing_fields(r: dict) -> list[str]:
    """手入力の系統で、まだ入っていない必須項目"""
    miss = []
    for k in ("id", "name", "source"):
        if not r.get(k):
            miss.append(k)
    if not (r.get("stations") or r.get("waypoints") or (r.get("from") and r.get("to"))):
        miss.append("stations / waypoints / from・to")
    svs = r.get("services") or []
    if not svs:
        miss.append("services")
    for s in svs:
        if not s.get("name") or s.get("stops") is None:
            miss.append(f"services[{s.get('name') or '?'}].stops")
    return miss


def apply_override(r: dict, ov: dict | None) -> dict:
    """services.yaml の系統に、手入力テンプレートの route_overrides（null は未入力として無視）を重ねる"""
    if not ov:
        return r
    r = json.loads(json.dumps(r))
    for k in ("max_speed_kmh", "max_speed_source", "offpeak_source"):
        if ov.get(k) is not None:
            r[k] = ov[k]
    if ov.get("peak") and ov["peak"].get("tph") is not None:
        r["peak"] = ov["peak"]
    for s in r["services"]:
        o = (ov.get("services") or {}).get(s["name"]) or {}
        for k in ("offpeak_tph", "tph_peak", "minutes"):
            if o.get(k) is not None:
                s[k] = o[k]
    return r


# ---------------------------------------------------------------------------
# 設定ファイルで定義した系統（停車駅は公表資料、所要時間は物理推定か公表資料）
# ---------------------------------------------------------------------------

def configured_routes(scfg: dict, nw: Network) -> tuple[list, list]:
    inp = scfg.get("input") or {}
    overrides = inp.get("route_overrides") or {}
    ratio = scfg["provisional"]["offpeak_ratio"]
    defs = [(r, "services.yaml") for r in scfg.get("routes") or []]
    skipped = []
    for r in inp.get("routes") or []:
        miss = missing_fields(r)
        if miss:
            skipped.append({"id": r.get("id") or "?", "name": r.get("name") or "", "missing": miss})
        else:
            defs.append((r, INPUT_FILE))
    out = []
    for r0, origin in defs:
        r = apply_override(r0, overrides.get(r0["id"]))
        lines = route_lines(nw, r)
        seq = route_sequence(nw, r, lines)
        names = [nw.stations[i]["name"] for i in seq]
        pk = peak_of(scfg, r, nw, lines)
        line0 = nw.lines[min(lines)]
        vmax_route = r.get("max_speed_kmh") or default_max_speed(scfg, line0)
        q_speed = "published" if r.get("max_speed_kmh") and r.get("max_speed_source") else "provisional"
        services, q_run, q_peak, q_off = [], [], [], []
        n_sv = len(r["services"])
        for s in r["services"]:
            if s["stops"] == "all":
                stops = list(range(len(seq)))
            else:
                missing = [x for x in s["stops"] if x not in names]
                if missing:
                    raise SystemExit(f"{r['id']}/{s['name']}: 経路上にない停車駅 {missing}（経路: {names}）")
                stops = sorted(names.index(x) for x in s["stops"])
            if s.get("minutes") is not None:
                # 公表の所要時間（始発からの分。停車駅ごと）
                mins = s["minutes"]
                if len(mins) != len(stops):
                    raise SystemExit(f"{r['id']}/{s['name']}: minutes の数 {len(mins)} が停車駅の数 {len(stops)} と違います")
                legs = [round(float(b - a), 2) for a, b in zip(mins[:-1], mins[1:])]
                q_run.append("published")
            else:
                legs = kinematic_legs(scfg, nw, seq, stops, lines, s.get("max_speed_kmh") or vmax_route, label=r["id"])
                # 停車駅は公表資料。最高速度も入力値なら「入力値」、既定値なら「既定値」の物理推定
                q_run.append("estimated" if q_speed == "published" or s.get("max_speed_kmh") else "estimated_default")
            if s.get("tph_peak") is not None:
                peak = float(s["tph_peak"])
                q_peak.append("published" if pk["quality"] == "published" or origin == INPUT_FILE else "provisional")
            else:
                share = s.get("share", 1.0 if n_sv == 1 else 1.0 / n_sv)
                peak = pk["tph"] * share
                # 種別が 1 つなら国交省の本数そのもの、複数なら種別への配分が仮置き
                q_peak.append(pk["quality"] if n_sv == 1 else "provisional")
            if s.get("offpeak_tph") is not None:
                off = float(s["offpeak_tph"])
                q_off.append("published")
            else:
                off = peak * ratio
                q_off.append("provisional")
            services.append({"name": s["name"], "stops": stops, "legMinutes": legs,
                             "tph": {"peak": round(peak, 1), "offpeak": round(off, 1)}})
        detail = {"stops": "published", "runTime": worst(q_run),
                  "maxSpeed": q_speed if {"estimated", "estimated_default"} & set(q_run) else None,
                  "peak": worst(q_peak), "offpeak": worst(q_off)}
        out.append({
            "id": r["id"], "name": r["name"], "operator": r.get("operator") or line0["operator"],
            "quality": detail["runTime"], "qualityDetail": detail, "maxSpeedKmh": vmax_route,
            "source": r.get("source", ""), "inputFrom": origin, "stations": seq, "cars": pk.get("cars"),
            "throughIds": r.get("through") or [], "services": services, "lineSet": sorted(lines),
            "frequencySource": pk["source"],
        })
    return out, skipped


# ---------------------------------------------------------------------------
# 系統を定義していない線: 各停（全駅停車）を既定値で物理推定
# ---------------------------------------------------------------------------

def provisional_routes(scfg: dict, nw: Network, covered: set) -> list:
    """設定・手入力で系統を定義していない N02 の線を、全駅停車の各停 1 種別として扱う。
    所要時間は運転曲線の簡易計算（最高速度は路線タイプ別の既定値）で、品質は「物理推定（既定値）」。
    優等列車（急行など）の停車パターンは手入力待ち（停車駅の品質は仮置き）。系統 ID は以前の仮置きの系統と同じ prov:<線>:<番号>
    （保存済みのシナリオの直通先の指定を壊さないため）。"""
    pcfg = scfg["provisional"]
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    line_freq = (scfg.get("input") or {}).get("line_frequency") or {}
    by_line = defaultdict(list)
    for ei, (a, b, li, d) in enumerate(nw.edges):
        if ei not in covered:
            by_line[li].append(ei)
    out = []
    for li, eis in sorted(by_line.items()):
        line = nw.lines[li]
        key = f"{line['operator']}/{line['name']}"
        lf = line_freq.get(key) or {}
        if lf.get("peak_tph") is not None:
            peak, cars, q_peak, src = float(lf["peak_tph"]), lf.get("cars") or mlit.get(key, {}).get("cars"), "published", lf.get("source") or "手入力"
        elif key in mlit:
            peak, cars, q_peak, src = mlit[key]["tph"], mlit[key]["cars"], "published", "国交省 混雑率データ（ピーク）"
        else:
            d = pcfg["tph_by_rail_type"].get(str(line["railType"])) or pcfg["tph_by_operator_type"].get(str(line["operatorType"]), {"peak": 8, "offpeak": 4})
            peak, cars, q_peak, src = d["peak"], None, "provisional", "仮置き"
        if lf.get("offpeak_tph") is not None:
            off, q_off = float(lf["offpeak_tph"]), "published"
        elif q_peak == "provisional" and lf.get("peak_tph") is None:
            off, q_off = d["offpeak"], "provisional"
        else:
            off, q_off = round(peak * pcfg["offpeak_ratio"], 1), "provisional"
        freq_src = src + ("、日中は手入力" if q_off == "published" else "、日中はピークの比率（仮置き）")
        vmax = default_max_speed(scfg, line)
        detail = {"stops": "provisional", "runTime": "estimated_default", "maxSpeed": "provisional", "peak": q_peak, "offpeak": q_off}

        # 未カバーのエッジを鎖（駅の並び）に分解する: 次数 1 の駅から順にたどる
        adj = defaultdict(list)
        for ei in eis:
            a, b, _, d = nw.edges[ei]
            adj[a].append((b, ei))
            adj[b].append((a, ei))
        unused = set(eis)
        k = 0
        while unused:
            starts = [n for n in adj if sum(1 for _, e in adj[n] if e in unused) == 1] or [nw.edges[next(iter(unused))][0]]
            n = starts[0]
            seq = [n]
            while True:
                nxt = [(m, e) for m, e in adj[n] if e in unused]
                if not nxt:
                    break
                m, e = nxt[0]
                unused.discard(e)
                seq.append(m)
                n = m
            legs = []
            for u, v in zip(seq[:-1], seq[1:]):
                d = min(nw.edges[e][3] for m, e in adj[u] if m == v)
                legs.append(leg_minutes(scfg, nw, d, v, vmax))
            out.append({
                "id": f"prov:{li}:{k}", "name": line["name"], "operator": line["operator"], "quality": "estimated_default",
                "qualityDetail": detail, "maxSpeedKmh": vmax,
                "source": "物理推定（既定値）: N02 の線ごとに全駅停車の各停、最高速度は路線タイプ別の既定値（services.yaml の runtime）",
                "frequencySource": freq_src,
                "stations": seq, "cars": cars,
                "services": [{"name": "各停", "stops": list(range(len(seq))), "legMinutes": legs,
                              "tph": {"peak": round(float(peak), 1), "offpeak": round(float(off), 1)}}],
                "lineSet": [li],
            })
            k += 1
    return out


# ---------------------------------------------------------------------------
# 物理推定の検証: 公表の所要時間・時刻表との比較
# ---------------------------------------------------------------------------

def service_minutes(r: dict, s: dict, a: int, b: int) -> float | None:
    """系統 r の種別 s で、駅 a から b（stations の位置）までの所要時間 [分]。どちらかに停まらなければ None"""
    if a not in s["stops"] or b not in s["stops"]:
        return None
    i, j = sorted((s["stops"].index(a), s["stops"].index(b)))
    legs = s["legMinutes"][i:j]
    return None if any(x is None for x in legs) else float(sum(legs))


def compare_published_times(scfg: dict, nw: Network, routes: list) -> list[dict]:
    """手入力テンプレートの published_times（主要区間の公表所要時間）とモデルの所要時間を比べる"""
    rows = []
    for e in (scfg.get("input") or {}).get("published_times") or []:
        if e.get("minutes") is None or not e.get("from") or not e.get("to"):
            continue
        if e.get("route"):
            cands = [r for r in routes if r["id"] == e["route"]]
        else:
            li = nw.line_key.get(e.get("line") or "")
            cands = [r for r in routes if li in r["_lines"]]
        best = None
        for r in cands:
            names = [nw.stations[i]["name"] for i in r["stations"]]
            if e["from"] not in names or e["to"] not in names:
                continue
            a, b = names.index(e["from"]), names.index(e["to"])
            for s in r["services"]:
                if e.get("service") and s["name"] != e["service"] and not r["id"].startswith("prov:"):
                    continue
                m = service_minutes(r, s, a, b)
                if m is not None and (best is None or QUALITIES.index(r["quality"]) < QUALITIES.index(best[0]["quality"])):
                    best = (r, s, m)
        row = {"label": e.get("route") or e.get("line"), "service": e.get("service") or "", "from": e["from"], "to": e["to"],
               "published": float(e["minutes"]), "source": e.get("source") or ""}
        if best:
            r, s, m = best
            row.update({"model": round(m, 1), "ratio": round(m / float(e["minutes"]), 3), "quality": r["quality"],
                        "modelRoute": f"{r['name']}（{s['name']}）"})
        rows.append(row)
    return rows


def validate_with_timetable(scfg: dict, nw: Network, routes: list) -> list[dict]:
    """時刻表ベースの系統で、同じ停車駅を運転曲線の簡易計算で走らせた所要時間と時刻表の所要時間を比べる。
    最高速度は既定値（仮置き）。余裕係数 1.15 はこの比較で決めたので、独立な検証ではない（ずれの大きさの目安）"""
    rows = []
    for r in routes:
        if r["quality"] != "timetable":
            continue
        line = nw.lines[Counter(nw.edges[ei][2] for ei in r["_edges"]).most_common(1)[0][0]]
        vmax = default_max_speed(scfg, line)
        for s in r["services"][:2]:
            ok = [k for k, x in enumerate(s["legMinutes"]) if x is not None]
            if not ok:
                continue
            est = kinematic_legs(scfg, nw, r["stations"], s["stops"], None, vmax, operator=r["operator"], label=r["id"])
            tt = sum(s["legMinutes"][k] for k in ok)
            mo = sum(est[k] for k in ok)
            first, last = s["stops"][0], s["stops"][-1]
            rows.append({"route": r["name"], "service": s["name"], "from": nw.stations[r["stations"][first]]["name"],
                         "to": nw.stations[r["stations"][last]]["name"], "vmax": vmax,
                         "timetable": round(tt, 1), "model": round(mo, 1), "ratio": round(mo / tt, 3)})
    return rows


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------

def covered_edges(route: dict, nw: Network) -> set:
    lines = set(route["lineSet"]) if route.get("lineSet") else None
    op = None if lines else route["operator"]
    used = set()
    seq = route["stations"]
    for a, b in zip(seq[:-1], seq[1:]):
        eis = nw.edges_between(a, b, op, lines)
        if not eis:
            _, eis = nw.leg_length(a, b, lines, op)
        used.update(eis)
    return used


def resolve_through(routes: list, lines_meta: list, stations_meta: list) -> None:
    """直通の関係を系統 ID の組にする: YAML の through（ID 指定）と ODPT の直通先（事業者・接続駅）"""
    by_id = {r["id"]: r for r in routes}
    for r in routes:
        out = []
        for t in r.pop("throughIds", []):
            if isinstance(t, dict):
                # {line: "運営会社/線名", at: 駅名}: その線を走る系統（仮置きを含む）のうち接続駅を含むもの
                li = next((k for k, l in enumerate(lines_meta) if f"{l['operator']}/{l['name']}" == t["line"]), None)
                at_idx = [k for k in r["stations"] if stations_meta[k]["name"] == t["at"]]
                cands = [o for o in routes if o is not r and li in o["_lines"] and set(at_idx) & set(o["stations"])]
                if not cands:
                    raise SystemExit(f"{r['id']}: 直通先 {t} の系統が見つかりません")
                for o in cands:
                    out.append({"route": o["id"], "at": at_idx, "share": None})
                continue
            if t not in by_id:
                raise SystemExit(f"{r['id']}: 直通先 {t} が見つかりません")
            at = set(r["stations"]) & set(by_id[t]["stations"])
            out.append({"route": t, "at": sorted(at), "share": None})
        for t in r.pop("throughRaw", []):
            cands = [o for o in routes if o is not r and o["operator"] == t["operator"] and t["at"] in o["stations"]]
            for o in cands:
                out.append({"route": o["id"], "at": [t["at"]], "share": t["share"]})
            if not cands:
                out.append({"route": None, "operator": t["operator"], "at": [t["at"]], "share": t["share"]})
        r["through"] = out


def main() -> None:
    scfg = load_services_config()
    stations = json.loads((PUBLIC_DATA / "stations.json").read_text(encoding="utf-8"))["stations"]
    net = json.loads((PUBLIC_DATA / "network.json").read_text(encoding="utf-8"))
    nw = Network(stations, net)

    tt, odpt_report = odpt_routes(scfg, nw)
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    for r in tt:
        # 時刻表ベースの系統: 編成両数と、ピーク本数の照合用に国交省の値を付ける（系統の主な N02 の線で引く）
        lines = Counter(nw.lines[nw.edges[ei][2]]["operator"] + "/" + nw.lines[nw.edges[ei][2]]["name"] for ei in covered_edges(r, nw))
        key = lines.most_common(1)[0][0] if lines else None
        if key in mlit:
            r["cars"] = mlit[key]["cars"]
            r["mlitPeakTph"] = mlit[key]["tph"]
        r["frequencySource"] = "時刻表"
        r["qualityDetail"] = {"stops": "timetable", "runTime": "timetable", "maxSpeed": None, "peak": "timetable", "offpeak": "timetable"}

    conf, skipped = configured_routes(scfg, nw)
    routes = tt + conf
    # エッジごとに、所要時間の品質が最も高い系統
    best: dict[int, dict] = {}

    def cover(r: dict) -> None:
        eis = covered_edges(r, nw)
        r["_lines"] = {nw.edges[ei][2] for ei in eis}
        r["_edges"] = eis
        for ei in eis:
            if ei not in best or QUALITIES.index(r["quality"]) < QUALITIES.index(best[ei]["quality"]):
                best[ei] = r

    for r in routes:
        cover(r)
    prov = provisional_routes(scfg, nw, set(best))
    for r in prov:
        cover(r)
    routes += prov
    resolve_through(routes, nw.lines, nw.stations)

    # 路線（N02 の線）ごとの品質: 所要時間の品質の延長の内訳と最も長いもの、項目ごとの品質（延長の最も長いもの）
    km = defaultdict(Counter)
    item_km = defaultdict(lambda: defaultdict(Counter))
    for ei, (a, b, li, d) in enumerate(nw.edges):
        r = best.get(ei)
        km[li][r["quality"] if r else "provisional"] += d / 1000
        if r:
            for it, q in r["qualityDetail"].items():
                if q:
                    item_km[li][it][q] += d / 1000
    line_quality, line_km, line_detail = [], [], []
    for li in range(len(nw.lines)):
        c = km[li]
        line_km.append({q: round(c[q], 2) for q in QUALITIES})
        line_quality.append(max(QUALITIES, key=lambda q: (c[q], -QUALITIES.index(q))) if c else "provisional")
        line_detail.append({it: (max(QUALITIES, key=lambda q: (item_km[li][it][q], -QUALITIES.index(q))) if item_km[li][it] else None)
                            for it in ITEMS})

    pub_rows = compare_published_times(scfg, nw, routes)
    tt_rows = validate_with_timetable(scfg, nw, routes)
    priority = input_priority(scfg, nw, routes, line_quality, line_km, line_detail, best)

    for r in routes:
        for k in ("lineSet", "_lines", "_edges"):
            r.pop(k, None)
    out = {
        "version": 1,
        "generatedAt": dt.date.today().isoformat(),
        "note": "運行系統（Phase 2）。stations は stations.json の添字、services[].stops は stations の位置、legMinutes は停車駅間の所要時間 [分]（停車時間込み）、"
                "tph は片方向の本数 [本/時]（peak = 朝ピーク、offpeak = 日中平均）。quality（所要時間の出所）: timetable=時刻表, published=公表資料, "
                "estimated=物理推定（停車駅と最高速度から運転曲線で計算）, provisional=仮置き。qualityDetail は項目ごとの出所。",
        "routes": routes,
        "lineQuality": line_quality,
        "lineQualityDetail": line_detail,
        "lineKm": line_km,
    }
    manifest_path = ODPT_DIR / "manifest.json"
    if manifest_path.exists():
        man = json.loads(manifest_path.read_text(encoding="utf-8"))
        out["odptRetrieved"] = {k: v["retrieved"] for k, v in man.items() if "TrainTimetable" in k}
    size = write_json(PUBLIC_DATA / "services.json", out)
    write_coverage(routes, nw, line_quality, line_km, line_detail, odpt_report, scfg, pub_rows, tt_rows, skipped)
    write_priority(priority, skipped, scfg)
    n = Counter(r["quality"] for r in routes)
    print("運行系統: " + " / ".join(f"{QUALITY_LABEL[q]} {n[q]}" for q in QUALITIES) + f"、services.json {size / 1024:.0f} KB")
    if skipped:
        print(f"手入力テンプレートの未入力の系統: {len(skipped)}（{INPUT_FILE}）")


# ---------------------------------------------------------------------------
# 手入力の優先順
# ---------------------------------------------------------------------------

def station_ridership(s: dict) -> float:
    rd = s.get("ridership") or {}
    v = rd.get("2024")
    if v is None:
        v = rd.get("2019")
    return float(v or 0)


def input_priority(scfg, nw, routes, line_quality, line_km, line_detail, best) -> dict:
    """手入力をお願いしたい線・系統の優先順。
    重み = 線の駅の乗降客数（S12）の合計 × 対象の延長の割合。乗降の多い線ほど、所要時間・本数の誤差が需要推計に効くため。
    A: 系統を定義していない線（各停だけの既定値の物理推定）の延長が半分以上の線、B: 設定で定義した系統"""
    undefined_km = defaultdict(float)
    for ei, (a, b, li, d) in enumerate(nw.edges):
        if ei in best and best[ei]["id"].startswith("prov:"):
            undefined_km[li] += d / 1000
    in_region = {i for i, s in enumerate(nw.stations) if s["inRegion"]}
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    lf_in = (scfg.get("input") or {}).get("line_frequency") or {}
    # ODPT のアクセストークン（開発者登録）があれば時刻表ベースになる事業者
    odpt_key_ops = {o["name"] for o in scfg["odpt"]["operators"].values() if o.get("access") == "key"}
    defined_in_input = {}
    for r in (scfg.get("input") or {}).get("routes") or []:
        for k in r.get("lines") or []:
            defined_in_input.setdefault(k, []).append(r.get("id"))
    line_st = defaultdict(set)
    for (a, b, li, d) in nw.edges:
        line_st[li].update((a, b))
    lines_out = []
    for li in sorted({li for (a, b, li, d) in nw.edges if a in in_region or b in in_region}):
        l = nw.lines[li]
        key = f"{l['operator']}/{l['name']}"
        total = sum(line_km[li].values())
        prov = undefined_km[li]
        rid = sum(station_ridership(nw.stations[i]) for i in line_st[li])
        det = line_detail[li]
        # 延長の半分以上が仮置きの線だけ（設定ファイルで系統を定義した線の不足は B の系統ごとの一覧に出す）
        if prov / max(total, 1e-9) < 0.5:
            continue
        need = ["優等列車の停車パターン（あれば）"]
        if det.get("peak") == "provisional":
            need.append("ピーク本数")
        if det.get("offpeak") == "provisional":
            need.append("日中本数")
        # 系統の終端（仮置きの系統の最も長い鎖）: テンプレートの from / to の目安
        chains = [r for r in routes if r["id"].startswith(f"prov:{li}:")]
        ends = []
        for r in sorted(chains, key=lambda r: -len(r["stations"]))[:2]:
            ends.append((nw.stations[r["stations"][0]]["name"], nw.stations[r["stations"][-1]]["name"], len(r["stations"])))
        share = prov / max(total, 1e-9)
        lines_out.append({"line": key, "km": round(total, 1), "provisionalKm": round(prov, 1), "ridership": rid,
                          "score": rid * share, "need": need, "mlitPeak": mlit.get(key, {}).get("tph"),
                          "odptKey": l["operator"] in odpt_key_ops,
                          "quality": line_quality[li], "ends": ends,
                          "inInput": defined_in_input.get(key, []) + (["line_frequency"] if key in lf_in else [])})
    lines_out.sort(key=lambda x: -x["score"])
    routes_out = []
    for r in routes:
        if r["quality"] == "timetable" or r["id"].startswith("prov:"):
            continue
        det = r["qualityDetail"]
        need = [ITEM_LABEL[it] for it in ("peak", "offpeak") if det.get(it) == "provisional"]
        if not need:
            continue
        rid = sum(station_ridership(nw.stations[i]) for i in set(r["stations"]))
        routes_out.append({"id": r["id"], "name": r["name"], "ridership": rid, "need": need,
                           "maxSpeedDefault": det.get("maxSpeed") == "provisional"})
    routes_out.sort(key=lambda x: -x["ridership"])
    out = {"lines": lines_out, "routes": routes_out}
    path = INTERIM / "services_priority.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def write_priority(pr: dict, skipped: list, scfg: dict) -> None:
    L = []
    w = L.append
    w("# 運行データの手入力: 優先順リスト（自動生成）")
    w("")
    w(f"生成: `scripts/06_services.py`（{dt.date.today().isoformat()}）。入力先は `scripts/config/regions/<地域>/{INPUT_FILE}`（書式はファイル冒頭の説明）。")
    w("入力したら `scripts/run_pipeline.py 06_services` → `scripts/calibrate.py` を実行する（README「運行データの手入力」）。")
    w("")
    w("優先度 = 線の駅の 1 日の乗降客数（S12、2024 年度。乗換駅は各線に重複して数える）の合計 × 対象の延長の割合。")
    w("乗降の多い線ほど、所要時間・本数の誤差が需要推計（一般化費用）に効くため。")
    w("")
    w("手入力の対象は **優等列車の停車パターンと日中本数** に絞っている。各停は全駅停車、最高速度は路線タイプ別の既定値で物理推定済み（品質「物理推定（既定値）」）。")
    w("最高速度は任意（公表値を入れると、停車駅も公表資料の系統は「物理推定（入力値）」になる）。")
    w("")
    w("## A. 優等列車の停車パターンと本数の入力が必要な線")
    w("")
    w("系統を定義していない線（各停だけ、既定値の物理推定）。急行などがある線は種別と停車駅を、各停だけの線は日中本数だけ入れればよい"
      "（`routes` に各停だけの系統を書くか、`line_frequency` に本数だけ）。")
    w("")
    w("「ODPT」欄の ○ は、ODPT の開発者登録が承認されれば時刻表ベースに置き換わる事業者（後回しにしてよい）。")
    w("")
    w("記入状況: 「雛形」= テンプレートに枠があり未入力（計算に未使用）、「入力済み」= 計算に使っている。")
    w("")
    w("| 順位 | 線（N02） | 延長 km（うち系統未定義） | 乗降合計 万人/日 | 国交省のピーク本数 | 必要な入力 | 系統の端の駅（目安） | ODPT | 記入状況 |")
    w("|---|---|---|---|---|---|---|---|---|")
    skipped_ids = {s["id"] for s in skipped}
    for k, x in enumerate(pr["lines"], 1):
        ends = "、".join(f"{a}〜{b}（{n}駅）" for a, b, n in x["ends"]) or "—"
        pk = f"{x['mlitPeak']:g}" if x["mlitPeak"] is not None else "—"
        st = "、".join(f"{i}（{'雛形' if i in skipped_ids else '入力済み'}）" for i in x["inInput"]) if x["inInput"] else "未"
        od = "○" if x["odptKey"] else ""
        w(f"| {k} | {x['line']} | {x['km']:.1f}（{x['provisionalKm']:.1f}） | {x['ridership'] / 1e4:,.1f} | {pk} | {'、'.join(x['need'])} | {ends} | {od} | {st} |")
    w("")
    w("## B. 定義済みの系統で仮置きの項目")
    w("")
    w("停車駅は公表資料（JR東日本の路線図）、所要時間は物理推定の系統。`route_overrides` に入れる。最高速度（任意）は既定値のままの系統に ○。")
    w("")
    w("| 順位 | 系統 | 乗降合計 万人/日 | 仮置きの項目 | 最高速度が既定値（任意） |")
    w("|---|---|---|---|---|")
    for k, x in enumerate(pr["routes"], 1):
        w(f"| {k} | {x['name']}（`{x['id']}`） | {x['ridership'] / 1e4:,.1f} | {'、'.join(x['need'])} | {'○' if x['maxSpeedDefault'] else ''} |")
    w("")
    if skipped:
        w("## C. テンプレートで未入力の系統（計算に使っていない）")
        w("")
        w("| 系統 | 未入力の必須項目 |")
        w("|---|---|")
        for s in skipped:
            w(f"| {s['name']}（`{s['id']}`） | {'、'.join(s['missing'])} |")
        w("")
    p = docs_path("services_input_priority.md")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(L), encoding="utf-8", newline="\n")


def write_coverage(routes, nw, line_quality, line_km, line_detail, odpt_report, scfg, pub_rows, tt_rows, skipped) -> None:
    in_region = {i for i, s in enumerate(nw.stations) if s["inRegion"]}
    region_lines = sorted({li for (a, b, li, d) in nw.edges if a in in_region or b in in_region})
    tot = Counter()
    cnt = Counter()
    for li in region_lines:
        for q in QUALITIES:
            tot[q] += line_km[li][q]
        cnt[line_quality[li]] += 1
    L = []
    w = L.append
    w("# 既存ネットワークの運行データ: カバー状況（自動生成）")
    w("")
    w(f"生成: `scripts/06_services.py`（{dt.date.today().isoformat()}）。データ構造は design.md §11、設定は `scripts/config/regions/<地域>/services.yaml` と `{INPUT_FILE}`（手入力）。")
    w("対象地域に駅を持つ N02 の線について集計した。")
    w("")
    w("品質フラグ（所要時間の出所。線ごとに延長の最も長いもの）:")
    w("時刻表 = ODPT のオープンデータの時刻表から集計、公表資料 = 公表の所要時間を手入力、")
    w("物理推定（入力値）= 公表資料の停車駅と最高速度（手入力）から運転曲線の簡易計算、")
    w("物理推定（既定値）= 停車駅か最高速度が既定値（系統を定義していない線は全駅停車の各停だけ、最高速度は路線タイプ別の既定値）、仮置き = 上記がない。")
    w("")
    w("| 品質（所要時間） | 線の数 | 延長 [km] | 割合（延長） |")
    w("|---|---|---|---|")
    total_km = sum(tot.values())
    for q in QUALITIES:
        w(f"| {QUALITY_LABEL[q]} | {cnt[q]} | {tot[q]:,.0f} | {tot[q] / total_km:.0%} |")
    w(f"| 計 | {len(region_lines)} | {total_km:,.0f} | |")
    w("")
    w("### 項目ごとの品質（線の数）")
    w("")
    w("| 項目 | " + " | ".join(QUALITY_LABEL[q] for q in QUALITIES) + " | 該当なし |")
    w("|---|" + "---|" * (len(QUALITIES) + 1))
    for it in ITEMS:
        c = Counter(line_detail[li].get(it) for li in region_lines)
        w(f"| {ITEM_LABEL[it]} | " + " | ".join(str(c[q]) for q in QUALITIES) + f" | {c[None]} |")
    w("")
    w("最高速度は物理推定の系統だけが使う（時刻表の線は「該当なし」）。停車駅の「仮置き」は、各停の全駅停車だけで優等列車の停車パターンが未入力のもの。")
    w("")
    w("## 物理推定の検証")
    w("")
    w("### 公表の所要時間との比較（手入力の published_times）")
    w("")
    if pub_rows:
        w("| 線・系統 | 種別 | 区間 | 公表 [分] | モデル [分] | 比 | モデルの系統（品質） | 出典 |")
        w("|---|---|---|---|---|---|---|---|")
        for x in pub_rows:
            if "model" in x:
                w(f"| {x['label']} | {x['service']} | {x['from']}→{x['to']} | {x['published']:g} | {x['model']:g} | {x['ratio']:.2f} | "
                  f"{x['modelRoute']}（{QUALITY_LABEL[x['quality']]}） | {x['source']} |")
            else:
                w(f"| {x['label']} | {x['service']} | {x['from']}→{x['to']} | {x['published']:g} | — | — | 対応する系統なし | {x['source']} |")
    else:
        w("まだ入力がない。")
    w("")
    w("### 時刻表（ODPT）との比較")
    w("")
    w("時刻表ベースの系統の停車駅を、運転曲線の簡易計算（最高速度は既定値＝仮置き）で走らせた所要時間。余裕係数 1.15 はこの比較で決めたので独立な検証ではなく、"
      "路線ごとのずれの大きさの目安。")
    w("")
    w("| 系統 | 種別 | 区間 | 最高速度（仮置き） | 時刻表 [分] | 物理推定 [分] | 比 |")
    w("|---|---|---|---|---|---|---|")
    for x in tt_rows:
        w(f"| {x['route']} | {x['service']} | {x['from']}→{x['to']} | {x['vmax']:g} | {x['timetable']:g} | {x['model']:g} | {x['ratio']:.2f} |")
    w("")
    w("## 国交省の混雑率データ（Phase 2 の混雑率計算の検証用）")
    w("")
    w("輸送力 ÷（本数 × 編成両数）= 1 両あたりの定員。新線の輸送力の計算（src/config/transitTypes.ts の capacityPerCar）と比べる。")
    w("")
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    jr = scfg.get("mlit_peak_jr", {})
    per_car = defaultdict(list)
    kind_of = {}
    for key, m in list(mlit.items()) + [(f"JR/{k}", v) for k, v in jr.items()]:
        if not m.get("capacity"):
            continue
        if key in kind_of:
            continue
        li = nw.line_key.get(key)
        rt = str(nw.lines[li]["railType"]) if li is not None else "11"
        kind = {"14": "モノレール", "15": "モノレール", "22": "モノレール", "23": "モノレール", "16": "新交通", "24": "新交通", "21": "路面電車"}.get(rt, "普通鉄道")
        kind_of[key] = kind
        per_car[kind].append(m["capacity"] / (m["tph"] * m["cars"]))
    w("| 種類 | 区間の数 | 1 両あたりの定員 中央値 [人] | 範囲 |")
    w("|---|---|---|---|")
    for kind, v in per_car.items():
        w(f"| {kind} | {len(v)} | {np.median(v):.0f} | {min(v):.0f}〜{max(v):.0f} |")
    w("")
    w("混雑率（輸送人員 ÷ 輸送力）は各線の最混雑区間のピーク 1 時間の値で、services.yaml の mlit_peak に入れてある。"
      "既存線の断面輸送量を推計する Phase 3 で、ピーク率（1 日に対するピーク 1 時間の割合、仮置き 0.15）と混雑の不効用の検証に使う。")
    w("")
    w("## 設定ファイルで定義した系統")
    w("")
    w("ピーク合計は全種別の最も多い 1 時間（駅・方向別）、国交省は最混雑区間の 1 時間（7:30〜8:30 頃）の本数。")
    w("")
    w("| 系統 | 事業者 | 品質（所要時間） | 停車駅 / 最高速度 / ピーク / 日中 | 駅数 | 種別（ピーク / 日中 本/時） | ピーク合計 / 国交省 | 直通先 | 出典 |")
    w("|---|---|---|---|---|---|---|---|---|")
    by_id = {r["id"]: r for r in routes}

    def ql(q):
        return QUALITY_LABEL[q] if q else "—"

    for r in routes:
        if r["quality"] == "provisional":
            continue
        d = r["qualityDetail"]
        dd = " / ".join(ql(d.get(it)) for it in ("stops", "maxSpeed", "peak", "offpeak"))
        sv = "、".join(f"{s['name']} {s['tph']['peak']:g}/{s['tph']['offpeak']:g}" for s in r["services"])
        th = "、".join(sorted({(by_id[t["route"]]["name"] if t["route"] else t["operator"] + "（系統なし）") for t in r["through"]}))
        pk = f"{r.get('peakTotalTph', '—')} / {r.get('mlitPeakTph', '—')}"
        w(f"| {r['name']} | {r['operator']} | {QUALITY_LABEL[r['quality']]} | {dd} | {len(r['stations'])} | {sv} | {pk} | {th} | {r['source']} |")
    w("")
    w("## 線ごとの品質（対象地域内）")
    w("")
    w("| 事業者 | 線（N02） | 品質（所要時間） | 停車駅 / ピーク / 日中 | " + " | ".join(f"{QUALITY_LABEL[q]} km" for q in QUALITIES) + " |")
    w("|---|---|---|---|" + "---|" * len(QUALITIES))
    for li in sorted(region_lines, key=lambda i: (nw.lines[i]["operator"], nw.lines[i]["name"])):
        l = nw.lines[li]
        k = line_km[li]
        d = line_detail[li]
        dd = " / ".join(ql(d.get(it)) for it in ("stops", "peak", "offpeak"))
        w(f"| {l['operator']} | {l['name']} | {QUALITY_LABEL[line_quality[li]]} | {dd} | " + " | ".join(f"{k[q]:.1f}" for q in QUALITIES) + " |")
    w("")
    if odpt_report:
        w("## ODPT の駅の対応付け")
        w("")
        for rid, rep in odpt_report.items():
            um = f"、対応付けできなかった駅 {len(rep['unmatched'])}: {', '.join(x.split('.')[-1] for x in rep['unmatched'])}" if rep["unmatched"] else ""
            w(f"- {rid}: 駅 {rep['stations']}、平日の列車 {rep['trains']}{um}")
        w("")
    out_md = docs_path("services_coverage.md")
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text("\n".join(L), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
