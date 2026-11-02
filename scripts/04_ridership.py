"""S12 駅別乗降客数を駅グループに集計し、public/data/<地域>/stations.json を作る。

S12 の扱い（docs/data-sources.md, docs/design.md §5.1）:
- 各年度の値は「重複コード=1（当該路線駅に記載）かつ データ有無=1」の行のみ合計する（二重計上の回避）。
- 重複コード=2（他路線駅に記載）の行は、同じ事業者・同じ駅名の記載行と同じ「乗降集計クラスタ」にまとめる。
  例: JR 武蔵小杉の横須賀線ホームは南武線の駅グループに計上されているため、両グループを 1 クラスタにする。
  校正では、クラスタ内の駅の推計値の合計を観測値と比較する。
- 備考が「1日当たりの乗車人員数」の行は乗車のみの値なので 2 倍して乗降に換算する。
- 備考に「新幹線を含む」とある行は新幹線利用者を含むため、フラグを立てて校正時に除外を検討する。
- データ無し・非公開の行が含まれるクラスタは partial とする（観測値が過小）。
"""

from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio

from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, ksj_zip, load_config, vsizip, write_json

# S12 の年度別列: 2011 年度が S12_006〜009、以降 4 列ずつ
def year_cols(year: int) -> tuple[str, str, str, str]:
    base = 6 + 4 * (year - 2011)
    return tuple(f"S12_{base + i:03d}" for i in range(4))  # 重複, データ有無, 備考, 乗降客数


YEARS = [2019, 2024]


class UnionFind:
    def __init__(self, items) -> None:
        self.parent = {x: x for x in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def main() -> None:
    cfg = load_config()
    z = ksj_zip(cfg, "S12")
    stem = cfg["sources"]["S12"]["version"]
    s12 = pyogrio.read_dataframe(vsizip(z, f"{stem}_GML/UTF-8/{stem}_NumberOfPassengers.geojson"))
    s12 = s12.rename(columns={"S12_001": "name", "S12_001c": "code", "S12_002": "operator", "S12_003": "line"})

    stations = pd.read_csv(INTERIM / "stations.csv", dtype={"id": str})
    members = pd.read_csv(INTERIM / "station_members.csv", dtype={"code": str, "group": str})
    code_to_group = dict(zip(members["code"], members["group"]))

    # 1) 駅コードで N02 の駅グループに対応付け
    s12["group"] = s12["code"].map(code_to_group)
    # 2) コードが合わない行は「同名かつ 300m 以内の駅グループ」で対応付け
    unmatched = s12["group"].isna()
    if unmatched.any():
        st_pts = gpd.GeoDataFrame(stations, geometry=gpd.points_from_xy(stations["lng"], stations["lat"]),
                                  crs=CRS_GEO).to_crs(CRS_METRIC)
        um = s12[unmatched].copy()
        um["geometry"] = um.geometry.to_crs(CRS_METRIC).centroid
        um = gpd.GeoDataFrame(um, geometry="geometry", crs=CRS_METRIC)
        joined = gpd.sjoin_nearest(um, st_pts[["id", "name", "geometry"]], max_distance=300,
                                   distance_col="dist", lsuffix="s12", rsuffix="st")
        joined = joined[joined["name_s12"] == joined["name_st"]]
        joined = joined[~joined.index.duplicated()]
        s12.loc[joined.index, "group"] = joined["id"]
    s12 = s12[s12["group"].notna()].copy()
    print(f"S12 行: 対象地域＋バッファ内で対応付け {len(s12):,} 行（うち駅コード一致 {int((~unmatched[s12.index]).sum()):,}）")

    # 乗降集計クラスタ: 同じ事業者・同じ駅名で重複コード 1/2 の行を持つグループを結合
    uf = UnionFind(stations["id"])
    latest_dup = year_cols(YEARS[-1])[0]
    for _, rows in s12[s12[latest_dup].isin(["1", "2", 1, 2])].groupby(["operator", "name"]):
        gs = rows["group"].unique()
        for g in gs[1:]:
            uf.union(gs[0], g)
    stations["cluster"] = stations["id"].map(uf.find)

    notes = s12[year_cols(YEARS[-1])[2]].fillna("")
    boarding_only = notes.str.contains("乗車人員")
    shinkansen = notes.str.contains("新幹線を含む")
    print("「乗車人員」行の事業者:", s12.loc[boarding_only, "operator"].value_counts().to_dict())
    print("「新幹線を含む」行の駅:", sorted(set(s12.loc[shinkansen, "name"])))

    s12["cluster"] = s12["group"].map(dict(zip(stations["id"], stations["cluster"])))
    cluster_stats: dict[str, dict] = {c: {} for c in stations["cluster"].unique()}
    for year in YEARS:
        dup, exist, note, val = year_cols(year)
        d = s12[[dup, exist, note, val, "cluster"]].copy()
        d[dup] = d[dup].astype(str)
        d[exist] = d[exist].astype(str)
        d["v"] = pd.to_numeric(d[val], errors="coerce").fillna(0)
        d.loc[d[note].fillna("").str.contains("乗車人員"), "v"] *= 2
        valid = (d[dup] == "1") & (d[exist] == "1")
        missing = (d[dup] == "1") & d[exist].isin(["2", "3"])
        for c, g in d.groupby("cluster"):
            v = g.loc[valid[g.index], "v"].sum()
            n_valid = int(valid[g.index].sum())
            cluster_stats[c][year] = {
                "v": int(round(v)) if n_valid > 0 else None,
                "partial": bool(missing[g.index].any()),
            }
    shinkansen_clusters = set(s12.loc[shinkansen, "cluster"])

    # クラスタ内の代表駅（ID 最小）にのみ観測値を持たせ、他のメンバーは cluster で参照する
    rows = []
    for _, r in stations.iterrows():
        cs = cluster_stats.get(r["cluster"], {})
        is_rep = r["id"] == r["cluster"]
        rows.append({
            "id": r["id"],
            "name": r["name"],
            "lng": r["lng"],
            "lat": r["lat"],
            "lines": [int(x) for x in str(r["lines"]).split(";") if x != ""],
            "operators": [x for x in str(r["operators"]).split(";") if x],
            "inRegion": int(r["in_region"]),
            "cluster": r["cluster"],
            "ridership": {str(y): (cs.get(y, {}).get("v") if is_rep else None) for y in YEARS},
            "partial": bool(any(cs.get(y, {}).get("partial") for y in YEARS)) if is_rep else False,
            "includesShinkansen": bool(r["cluster"] in shinkansen_clusters) if is_rep else False,
        })
    out = {
        "version": 1,
        "note": "ridership は S12 の 1日あたり乗降客数（乗降集計クラスタの代表駅にのみ値。乗車人員のみの事業者は2倍換算）。"
                "accessibility は M4 の校正で追加。",
        "years": YEARS,
        "stations": rows,
    }
    size = write_json(PUBLIC_DATA / "stations.json", out)

    df = pd.DataFrame(rows)
    in_r = df[df["inRegion"] == 1]
    reps = in_r[in_r["id"] == in_r["cluster"]]
    for y in YEARS:
        vals = reps["ridership"].map(lambda r: r[str(y)])
        has = vals.notna()
        print(f"{y}年度: 観測値のあるクラスタ {int(has.sum()):,} / {len(reps):,}、合計 {int(vals[has].sum()):,} 人/日、"
              f"中央値 {int(vals[has].median()):,}、最大 {int(vals[has].max()):,}（{reps.loc[vals[has].astype(float).idxmax(), 'name']}）")
    print(f"partial（一部事業者のデータ無し）: {int(reps['partial'].sum())}、新幹線含む: {int(reps['includesShinkansen'].sum())}")
    print(f"複数駅グループからなるクラスタ: {int((df.groupby('cluster').size() > 1).sum())}")
    print(f"stations.json: {size / 1024:.0f} KB")
    (INTERIM / "ridership.csv").write_text(
        df.assign(r2019=df["ridership"].map(lambda r: r["2019"]), r2024=df["ridership"].map(lambda r: r["2024"]))
          .drop(columns=["ridership"]).to_csv(index=False), encoding="utf-8")


if __name__ == "__main__":
    main()
