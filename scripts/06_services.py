"""既存ネットワークの運行データ（運行系統・種別・停車駅・駅間所要時間・時間帯別本数・直通）を作る（Phase 2 M1）。

入力:
  scripts/config/services.yaml   公表資料ベースの系統、ODPT・計算・仮置きの設定
  data/raw/odpt/                 ODPT の時刻表（scripts/odpt_download.py）
  public/data/stations.json, network.json
出力:
  public/data/services.json      運行系統（docs/design.md §11）
  docs/services_coverage.md      路線ごとのデータ品質（時刻表／公表資料／仮置き）の内訳

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

from common import PUBLIC_DATA, RAW, ROOT, load_config, write_json

HERE = Path(__file__).resolve().parent
ODPT_DIR = RAW / "odpt"
QUALITIES = ["timetable", "published", "provisional"]
QUALITY_LABEL = {"timetable": "時刻表", "published": "公表資料", "provisional": "仮置き"}


def load_services_config() -> dict:
    with (HERE / "config" / "services.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


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

    def path(self, a: int, b: int, lines: set | None = None, operator: str | None = None) -> list[int] | None:
        """駅 a から b までの最短経路（駅の並び）。lines / operator で使う線を制限する"""
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
                nd = d + w
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
            "source": f"ODPT {ocfg['operators'][op]['license']}（{rid}、平日）",
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
    if len(cands) != 1:
        raise SystemExit(f"駅「{name}」が線 {sorted(lines)} 上に {len(cands)} 件あります")
    return cands[0]


def published_routes(scfg: dict, nw: Network) -> list:
    rcfg = scfg["runtime"]
    ratio = scfg["provisional"]["offpeak_ratio"]
    out = []
    for r in scfg.get("routes") or []:
        lines = set()
        for k in r["lines"]:
            if k not in nw.line_key:
                raise SystemExit(f"{r['id']}: network.json に線 {k} がありません")
            lines.add(nw.line_key[k])
        a, b = station_on_lines(nw, r["from"], lines), station_on_lines(nw, r["to"], lines)
        seq = nw.path(a, b, lines)
        if seq is None:
            raise SystemExit(f"{r['id']}: {r['from']} から {r['to']} まで {r['lines']} でつながっていません")
        names = [nw.stations[i]["name"] for i in seq]
        services = []
        for s in r["services"]:
            if s["stops"] == "all":
                stops = list(range(len(seq)))
            else:
                missing = [x for x in s["stops"] if x not in names]
                if missing:
                    raise SystemExit(f"{r['id']}/{s['name']}: 経路上にない停車駅 {missing}（経路: {names}）")
                stops = sorted(names.index(x) for x in s["stops"])
            vmax = s.get("max_speed_kmh", r["max_speed_kmh"])
            legs = []
            for i, j in zip(stops[:-1], stops[1:]):
                dist, _ = nw.leg_length(seq[i], seq[j], lines)
                dwell = rcfg["dwell_major_s"] if len(nw.stations[seq[j]]["lines"]) >= 2 else rcfg["dwell_s"]
                sec = (run_seconds(dist, vmax, rcfg["accel_kmh_per_s"], rcfg["decel_kmh_per_s"]) + dwell) * rcfg["margin"]
                legs.append(round(sec / 60, 2))
            peak = r["peak"]["tph"] * s.get("share", 1.0)
            off = s.get("offpeak_tph", peak * ratio)
            services.append({"name": s["name"], "stops": stops, "legMinutes": legs,
                             "tph": {"peak": round(peak, 1), "offpeak": round(off, 1)}})
        out.append({
            "id": r["id"], "name": r["name"], "operator": nw.lines[next(iter(lines))]["operator"], "quality": "published",
            "source": r.get("source", ""), "stations": seq, "cars": r["peak"].get("cars"),
            "throughIds": r.get("through", []), "services": services, "lineSet": sorted(lines),
            "frequencySource": r["peak"].get("source", "国交省 混雑率データ"),
        })
    return out


# ---------------------------------------------------------------------------
# 仮置き
# ---------------------------------------------------------------------------

def provisional_routes(scfg: dict, nw: Network, covered: set) -> list:
    pcfg = scfg["provisional"]
    mlit = scfg.get("mlit_peak", {}).get("lines", {})
    by_line = defaultdict(list)
    for ei, (a, b, li, d) in enumerate(nw.edges):
        if ei not in covered:
            by_line[li].append(ei)
    out = []
    for li, eis in sorted(by_line.items()):
        line = nw.lines[li]
        key = f"{line['operator']}/{line['name']}"
        if key in mlit:
            tph = {"peak": mlit[key]["tph"], "offpeak": round(mlit[key]["tph"] * pcfg["offpeak_ratio"], 1)}
            cars, freq_src = mlit[key]["cars"], "国交省 混雑率データ（ピーク）、日中はピークの比率（仮置き）"
        else:
            tph = pcfg["tph_by_rail_type"].get(str(line["railType"])) or pcfg["tph_by_operator_type"].get(str(line["operatorType"]), {"peak": 8, "offpeak": 4})
            cars, freq_src = None, "仮置き"

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
                legs.append(round(d / 1000 / line["speedKmh"] * 60, 2))
            out.append({
                "id": f"prov:{li}:{k}", "name": line["name"], "operator": line["operator"], "quality": "provisional",
                "source": "仮置き（N02 の線ごとに全駅停車、表定速度は pipeline.yaml）", "frequencySource": freq_src,
                "stations": seq, "cars": cars,
                "services": [{"name": "各停", "stops": list(range(len(seq))), "legMinutes": legs,
                              "tph": {"peak": tph["peak"], "offpeak": tph["offpeak"]}}],
                "lineSet": [li],
            })
            k += 1
    return out


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


def resolve_through(routes: list) -> None:
    """直通の関係を系統 ID の組にする: YAML の through（ID 指定）と ODPT の直通先（事業者・接続駅）"""
    by_id = {r["id"]: r for r in routes}
    for r in routes:
        out = []
        for tid in r.pop("throughIds", []):
            if tid not in by_id:
                raise SystemExit(f"{r['id']}: 直通先 {tid} が見つかりません")
            at = set(r["stations"]) & set(by_id[tid]["stations"])
            out.append({"route": tid, "at": sorted(at), "share": None})
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

    pub = published_routes(scfg, nw)
    routes = tt + pub
    covered: dict[int, str] = {}
    for r in routes:
        for ei in covered_edges(r, nw):
            if ei not in covered or QUALITIES.index(r["quality"]) < QUALITIES.index(covered[ei]):
                covered[ei] = r["quality"]
    prov = provisional_routes(scfg, nw, set(covered))
    for r in prov:
        for ei in covered_edges(r, nw):
            covered.setdefault(ei, "provisional")
    routes += prov
    resolve_through(routes)

    # 路線（N02 の線）ごとの品質: 延長の内訳と、最も長い品質
    km = defaultdict(lambda: Counter())
    for ei, (a, b, li, d) in enumerate(nw.edges):
        km[li][covered.get(ei, "provisional")] += d / 1000
    line_quality = []
    line_km = []
    for li in range(len(nw.lines)):
        c = km[li]
        line_km.append({q: round(c[q], 2) for q in QUALITIES})
        line_quality.append(max(QUALITIES, key=lambda q: (c[q], -QUALITIES.index(q))) if c else "provisional")

    for r in routes:
        r.pop("lineSet", None)
    out = {
        "version": 1,
        "generatedAt": dt.date.today().isoformat(),
        "note": "運行系統（Phase 2）。stations は stations.json の添字、services[].stops は stations の位置、legMinutes は停車駅間の所要時間 [分]（停車時間込み）、"
                "tph は片方向の本数 [本/時]（peak = 朝ピーク、offpeak = 日中平均）。quality: timetable=時刻表, published=公表資料, provisional=仮置き。",
        "routes": routes,
        "lineQuality": line_quality,
        "lineKm": line_km,
    }
    size = write_json(PUBLIC_DATA / "services.json", out)
    write_coverage(routes, nw, line_quality, line_km, odpt_report, scfg)
    n = Counter(r["quality"] for r in routes)
    print(f"運行系統: 時刻表 {n['timetable']} / 公表資料 {n['published']} / 仮置き {n['provisional']}、services.json {size / 1024:.0f} KB")


def write_coverage(routes, nw, line_quality, line_km, odpt_report, scfg) -> None:
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
    w(f"生成: `scripts/06_services.py`（{dt.date.today().isoformat()}）。データ構造は design.md §11、設定は `scripts/config/services.yaml`。")
    w("対象地域に駅を持つ N02 の線について集計した。品質は線ごとに延長の最も長いもの。")
    w("")
    w("| 品質 | 線の数 | 延長 [km] | 割合（延長） |")
    w("|---|---|---|---|")
    total_km = sum(tot.values())
    for q in QUALITIES:
        w(f"| {QUALITY_LABEL[q]} | {cnt[q]} | {tot[q]:,.0f} | {tot[q] / total_km:.0%} |")
    w(f"| 計 | {len(region_lines)} | {total_km:,.0f} | |")
    w("")
    prov_lines_mlit = sum(1 for li in region_lines if line_quality[li] == "provisional"
                          and f"{nw.lines[li]['operator']}/{nw.lines[li]['name']}" in scfg.get("mlit_peak", {}).get("lines", {}))
    w(f"仮置きの線のうち {prov_lines_mlit} 線は、ピーク本数・編成両数だけ国交省の混雑率データ（公表資料）を使っている（停車駅・所要時間は仮置き）。")
    w("")
    w("## 時刻表ベース・公表資料ベースの系統")
    w("")
    w("ピーク合計は全種別の最も多い 1 時間（駅・方向別）、国交省は最混雑区間の 1 時間（7:30〜8:30 頃）の本数。")
    w("")
    w("| 系統 | 事業者 | 品質 | 駅数 | 種別（ピーク / 日中 本/時） | ピーク合計 / 国交省 | 直通先 | 出典 |")
    w("|---|---|---|---|---|---|---|---|")
    by_id = {r["id"]: r for r in routes}
    for r in routes:
        if r["quality"] == "provisional":
            continue
        sv = "、".join(f"{s['name']} {s['tph']['peak']:g}/{s['tph']['offpeak']:g}" for s in r["services"])
        th = "、".join(sorted({(by_id[t["route"]]["name"] if t["route"] else t["operator"] + "（系統なし）") for t in r["through"]}))
        pk = f"{r.get('peakTotalTph', '—')} / {r.get('mlitPeakTph', '—')}"
        w(f"| {r['name']} | {r['operator']} | {QUALITY_LABEL[r['quality']]} | {len(r['stations'])} | {sv} | {pk} | {th} | {r['source']} |")
    w("")
    w("## 線ごとの品質（対象地域内）")
    w("")
    w("| 事業者 | 線（N02） | 品質 | 時刻表 km | 公表資料 km | 仮置き km |")
    w("|---|---|---|---|---|---|")
    for li in sorted(region_lines, key=lambda i: (nw.lines[i]["operator"], nw.lines[i]["name"])):
        l = nw.lines[li]
        k = line_km[li]
        w(f"| {l['operator']} | {l['name']} | {QUALITY_LABEL[line_quality[li]]} | {k['timetable']:.1f} | {k['published']:.1f} | {k['provisional']:.1f} |")
    w("")
    if odpt_report:
        w("## ODPT の駅の対応付け")
        w("")
        for rid, rep in odpt_report.items():
            um = f"、対応付けできなかった駅 {len(rep['unmatched'])}: {', '.join(x.split('.')[-1] for x in rep['unmatched'])}" if rep["unmatched"] else ""
            w(f"- {rid}: 駅 {rep['stations']}、平日の列車 {rep['trains']}{um}")
        w("")
    (ROOT / "docs" / "services_coverage.md").write_text("\n".join(L), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
