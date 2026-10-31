"""既存鉄道（N02）の路線・駅グループ・ネットワークグラフを作る。

- 駅グループ: N02 のグループコード（同名かつ 300m 以内）単位。需要モデルの「駅」はこの単位。
- 隣接駅: 路線ごとに線路形状のグラフ（区間・駅の端点をノード）を作り、各駅から他の駅に
  当たるまで Dijkstra で探索して隣の駅と線路延長を求める（分岐線にも対応）。
- 徒歩乗換: 名前の異なる近接駅グループ（例: 浜松町と大門）を徒歩エッジで結ぶ。

出力:
  public/data/rail_lines.geojson   路線形状（対象地域＋バッファで切り出し、簡略化）
  public/data/network.json         路線一覧・隣接駅エッジ・徒歩乗換エッジ（駅は stations.json の添字）
  data/interim/stations.csv        駅グループ（04_ridership.py が乗降客数を付けて stations.json にする）
  data/interim/station_members.csv N02 の駅コード → 駅グループ
"""

from __future__ import annotations

import heapq
from collections import defaultdict

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
from shapely.ops import linemerge
from shapely.strtree import STRtree

from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, ksj_zip, load_config, vsizip, write_json


def read_n02(cfg: dict) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    z = ksj_zip(cfg, "N02")
    folder = z.name.replace(".zip", "") + "/Shift-JIS/"
    stem = cfg["sources"]["N02"]["version"]
    sec = pyogrio.read_dataframe(vsizip(z, folder + f"{stem}_RailroadSection.shp"), encoding="cp932")
    st = pyogrio.read_dataframe(vsizip(z, folder + f"{stem}_Station.shp"), encoding="cp932")
    rename = {"N02_001": "rail_type", "N02_002": "op_type", "N02_003": "line", "N02_004": "operator",
              "N02_005": "name", "N02_005c": "code", "N02_005g": "group"}
    sec = sec.rename(columns=rename)
    st = st.rename(columns=rename)
    for df in (sec, st):
        df["rail_type"] = df["rail_type"].astype(int)
        df["op_type"] = df["op_type"].astype(int)
        df["line_key"] = df["operator"] + "/" + df["line"]
    return sec.to_crs(CRS_METRIC), st.to_crs(CRS_METRIC)


def line_speed(rcfg: dict, operator: str, line: str, op_type: int, rail_type: int) -> float:
    sp = rcfg["speed_kmh"]
    if operator in sp["operator_overrides"]:
        return float(sp["operator_overrides"][operator])
    if f"{operator}/{line}" in sp["line_overrides"]:
        return float(sp["line_overrides"][f"{operator}/{line}"])
    if str(rail_type) in sp["rail_type"]:
        return float(sp["rail_type"][str(rail_type)])
    return float(sp["operator_type"][str(op_type)])


def node_key(xy: tuple[float, float]) -> tuple[int, int]:
    # 投影座標を 10cm 単位に丸めてノードを同一視する
    return (round(xy[0] * 10), round(xy[1] * 10))


def adjacent_stations(sections: gpd.GeoDataFrame, stations: gpd.GeoDataFrame) -> list[tuple[str, str, float]]:
    """1 路線内で隣り合う駅（N02 駅コード）の組と線路延長 [m] を返す。"""
    adj: dict[tuple[int, int], list[tuple[tuple[int, int], float]]] = defaultdict(list)

    def add_edge(geom) -> tuple[tuple[int, int], tuple[int, int]]:
        coords = list(geom.coords)
        a, b = node_key(coords[0]), node_key(coords[-1])
        w = geom.length
        adj[a].append((b, w))
        adj[b].append((a, w))
        return a, b

    for g in sections.geometry:
        add_edge(g)
    node_station: dict[tuple[int, int], str] = {}
    station_nodes: dict[str, tuple[tuple[int, int], ...]] = {}
    half_len: dict[str, float] = {}
    for code, g in zip(stations["code"], stations.geometry):
        a, b = add_edge(g)
        node_station[a] = code
        node_station[b] = code
        station_nodes[code] = (a, b)
        half_len[code] = g.length / 2

    pairs: dict[tuple[str, str], float] = {}
    for code, starts in station_nodes.items():
        dist = {n: 0.0 for n in starts}
        heap = [(0.0, n) for n in starts]
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, np.inf):
                continue
            other = node_station.get(n)
            if other is not None and other != code:
                key = (min(code, other), max(code, other))
                # ホーム端どうしの距離にホーム長の半分ずつを足して駅中心間の距離にする
                pairs[key] = min(pairs.get(key, np.inf), d + half_len[code] + half_len[other])
                continue  # 他の駅に当たったらその先は探索しない
            for m, w in adj[n]:
                nd = d + w
                if nd < dist.get(m, np.inf):
                    dist[m] = nd
                    heapq.heappush(heap, (nd, m))
    return [(a, b, d) for (a, b), d in pairs.items()]


def main() -> None:
    cfg = load_config()
    rcfg = cfg["rail"]
    sec, st = read_n02(cfg)
    n_sec0, n_st0 = len(sec), len(st)
    keep = lambda df: ~df["op_type"].isin(rcfg["exclude_operator_types"]) & ~df["rail_type"].isin(rcfg["exclude_rail_types"])
    sec, st = sec[keep(sec)].copy(), st[keep(st)].copy()
    print(f"N02 全国: 区間 {n_sec0:,} / 駅 {n_st0:,} → 新幹線・鋼索除外後 区間 {len(sec):,} / 駅 {len(st):,}")

    region = gpd.read_file(INTERIM / "region.gpkg", layer="region").geometry.iloc[0]
    buffer = gpd.read_file(INTERIM / "region.gpkg", layer="region_buffer").geometry.iloc[0]

    # --- 駅グループ -----------------------------------------------------------
    st["cx"] = st.geometry.centroid.x
    st["cy"] = st.geometry.centroid.y
    groups = st.groupby("group").agg(name=("name", "first"), x=("cx", "mean"), y=("cy", "mean")).reset_index()
    gpts = gpd.GeoSeries(gpd.points_from_xy(groups["x"], groups["y"]), crs=CRS_METRIC)
    groups["in_buffer"] = gpts.within(buffer).to_numpy()
    groups["in_region"] = gpts.within(region).to_numpy()
    groups = groups[groups["in_buffer"]].reset_index(drop=True)
    st = st[st["group"].isin(groups["group"])].copy()

    # --- 路線（バッファ内に駅を持つもの） --------------------------------------
    line_keys = sorted(st["line_key"].unique())
    line_meta = (st.drop_duplicates("line_key").set_index("line_key")[["line", "operator", "op_type", "rail_type"]])
    lines = []
    for i, key in enumerate(line_keys):
        m = line_meta.loc[key]
        lines.append({
            "id": i, "key": key, "name": m["line"], "operator": m["operator"],
            "operatorType": int(m["op_type"]), "railType": int(m["rail_type"]),
            "speedKmh": line_speed(rcfg, m["operator"], m["line"], int(m["op_type"]), int(m["rail_type"])),
        })
    line_index = {l["key"]: l["id"] for l in lines}

    group_index = {g: i for i, g in enumerate(groups["group"])}
    st["gi"] = st["group"].map(group_index)
    groups["lines"] = [sorted({line_index[k] for k in st.loc[st["group"] == g, "line_key"]}) for g in groups["group"]]
    groups["operators"] = [sorted(set(st.loc[st["group"] == g, "operator"])) for g in groups["group"]]

    # --- 隣接駅エッジ ---------------------------------------------------------
    sec_all, st_all = read_n02(cfg)  # 隣接判定はバッファ外の線路も含めて行う（駅間が境界を跨ぐ場合のため）
    code_to_gi = dict(zip(st["code"], st["gi"]))
    edges: dict[tuple[int, int, int], float] = {}
    for key in line_keys:
        s_line = sec_all[sec_all["line_key"] == key]
        t_line = st_all[st_all["line_key"] == key]
        for a, b, d in adjacent_stations(s_line, t_line):
            ga, gb = code_to_gi.get(a), code_to_gi.get(b)
            if ga is None or gb is None or ga == gb:
                continue
            k = (min(ga, gb), max(ga, gb), line_index[key])
            edges[k] = min(edges.get(k, np.inf), d)
    edge_list = [[a, b, li, round(d)] for (a, b, li), d in sorted(edges.items())]

    # 隣接駅が見つからない駅（形状の不連続など）を報告
    deg = defaultdict(int)
    for a, b, _, _ in edge_list:
        deg[a] += 1
        deg[b] += 1
    isolated = [groups.loc[i, "name"] for i in range(len(groups)) if deg[i] == 0]

    # --- 徒歩乗換エッジ ---------------------------------------------------------
    tree = STRtree(list(gpd.points_from_xy(groups["x"], groups["y"])))
    walk = []
    radius = rcfg["walk_transfer_radius_m"]
    gx, gy = groups["x"].to_numpy(), groups["y"].to_numpy()
    for i in range(len(groups)):
        for j in tree.query(gpd.points_from_xy([gx[i]], [gy[i]])[0].buffer(radius)):
            if j <= i:
                continue
            d = float(np.hypot(gx[i] - gx[j], gy[i] - gy[j]))
            if d <= radius:
                walk.append([i, int(j), round(d)])

    # --- 出力 ---------------------------------------------------------------
    lonlat = gpd.GeoSeries(gpd.points_from_xy(gx, gy), crs=CRS_METRIC).to_crs(CRS_GEO)
    dec = rcfg["coord_decimals"]
    stations_out = pd.DataFrame({
        "id": groups["group"], "name": groups["name"],
        "lng": lonlat.x.round(dec), "lat": lonlat.y.round(dec),
        "lines": [";".join(map(str, l)) for l in groups["lines"]],
        "operators": [";".join(o) for o in groups["operators"]],
        "in_region": groups["in_region"].astype(int),
    })
    INTERIM.mkdir(parents=True, exist_ok=True)
    stations_out.to_csv(INTERIM / "stations.csv", index=False)
    st[["code", "group", "name", "line_key", "operator"]].to_csv(INTERIM / "station_members.csv", index=False)

    net = {
        "version": 1,
        "note": "stations は stations.json の添字。edges=[駅a, 駅b, 路線添字, 線路延長m]、walk=[駅a, 駅b, 直線距離m]",
        "lines": [{k: v for k, v in l.items() if k != "key"} for l in lines],
        "edges": edge_list,
        "walk": walk,
    }
    net_size = write_json(PUBLIC_DATA / "network.json", net)

    # 表示用の路線形状: 区間＋駅の形状を路線ごとに結合し、バッファで切り出して簡略化
    shapes = pd.concat([sec_all[["line_key", "geometry"]], st_all[["line_key", "geometry"]]])
    shapes = shapes[shapes["line_key"].isin(line_index)]
    shapes = gpd.GeoDataFrame(shapes, crs=CRS_METRIC).clip(buffer)
    merged = shapes.dissolve("line_key").reset_index()
    merged["geometry"] = [linemerge(g) if g.geom_type == "MultiLineString" else g for g in merged.geometry]
    merged["geometry"] = merged.simplify(rcfg["simplify_tolerance_m"])
    merged["id"] = merged["line_key"].map(line_index)
    meta = pd.DataFrame(lines).set_index("id")
    merged["name"] = merged["id"].map(meta["name"])
    merged["operator"] = merged["id"].map(meta["operator"])
    merged["operatorType"] = merged["id"].map(meta["operatorType"])
    merged = merged[["id", "name", "operator", "operatorType", "geometry"]].sort_values("id").to_crs(CRS_GEO)
    out = PUBLIC_DATA / "rail_lines.geojson"
    out.unlink(missing_ok=True)
    merged.to_file(out, driver="GeoJSON", COORDINATE_PRECISION=dec)

    print(f"駅グループ: {len(groups):,}（対象地域内 {int(groups['in_region'].sum()):,}）/ N02 駅 {len(st):,}")
    print(f"路線: {len(lines)}（事業者 {len({l['operator'] for l in lines})}）")
    print(f"隣接駅エッジ: {len(edge_list):,} / 徒歩乗換エッジ: {len(walk):,}")
    print(f"隣接駅が見つからない駅グループ: {len(isolated)} {isolated[:20]}")
    print(f"network.json: {net_size / 1024:.0f} KB / rail_lines.geojson: {out.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
