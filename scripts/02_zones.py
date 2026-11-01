"""500m メッシュの人口・従業者数を結合してゾーンデータを作る。

入力: e-Stat 統計GIS の 1次メッシュ単位 ZIP（国勢調査 2020 / 経済センサス‐活動調査 2021、JGD2011）
出力: public/data/zones.json（列指向）、data/interim/zones.csv（検証用）

秘匿処理: 国勢調査の HTKSYORI=2（秘匿地域）は詳細項目が合算先（HTKSYORI=1）に合算されるが、
人口総数は各メッシュの値がそのまま公表されている。全メッシュの単純合計が都県の公表人口と
0.5% 以内で一致することを確認済み（M1）なので、人口総数はそのまま使う。
数値でない値（「*」「-」）は 0 とし、件数を報告する。
"""

from __future__ import annotations

import io
import zipfile

import geopandas as gpd
import numpy as np
import pandas as pd

from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, RAW, half_mesh_centroid, load_config, write_json


def read_estat_tables(folder: str, stats_id: str, meshes: list[str], usecols: list[str]) -> pd.DataFrame:
    frames = []
    for mesh in meshes:
        z = RAW / "estat" / folder / f"{stats_id}_{mesh}.zip"
        with zipfile.ZipFile(z) as zf:
            name = zf.namelist()[0]
            raw = zf.read(name).decode("cp932")
        # 1行目: 項目コード、2行目: 項目名（読み飛ばす）
        df = pd.read_csv(io.StringIO(raw), skiprows=[1], dtype=str)
        frames.append(df[[c for c in usecols if c in df.columns]])
    return pd.concat(frames, ignore_index=True)


def to_number(s: pd.Series) -> tuple[pd.Series, int]:
    """「*」「-」などの秘匿・該当なしを 0 に置き換え、置き換えた件数も返す。"""
    num = pd.to_numeric(s, errors="coerce")
    n_masked = int(num.isna().sum())
    return num.fillna(0).astype(np.int64), n_masked


def main() -> None:
    cfg = load_config()
    src = cfg["sources"]
    meshes = cfg["primary_meshes"]

    pop_col = src["census"]["population_column"]
    census = read_estat_tables("census2020", src["census"]["stats_id"], meshes, ["KEY_CODE", "HTKSYORI", pop_col])
    census["pop"], n_pop_masked = to_number(census[pop_col])
    n_hidden = int((census["HTKSYORI"] == "2").sum())

    emp_col = src["econ_census"]["employees_column"]
    econ = read_estat_tables("econ2021", src["econ_census"]["stats_id"], meshes, ["KEY_CODE", emp_col])
    econ["emp"], n_emp_masked = to_number(econ[emp_col])

    zones = pd.merge(census[["KEY_CODE", "pop"]], econ[["KEY_CODE", "emp"]], on="KEY_CODE", how="outer")
    zones[["pop", "emp"]] = zones[["pop", "emp"]].fillna(0).astype(np.int64)
    zones = zones[(zones["pop"] > 0) | (zones["emp"] > 0)].copy()
    assert zones["KEY_CODE"].str.len().eq(9).all(), "2分の1メッシュ以外のコードが混入"

    lng, lat = half_mesh_centroid(zones["KEY_CODE"])
    pts = gpd.GeoDataFrame(zones, geometry=gpd.points_from_xy(lng, lat), crs=CRS_GEO).to_crs(CRS_METRIC)

    region = gpd.read_file(INTERIM / "region.gpkg", layer="region").geometry.iloc[0]
    buffer = gpd.read_file(INTERIM / "region.gpkg", layer="region_buffer").geometry.iloc[0]
    in_buffer = pts.within(buffer)
    pts = pts[in_buffer].copy()
    pts["in_region"] = pts.within(region)
    pts = pts.sort_values("KEY_CODE")

    out = {
        "version": 1,
        "meshLevel": "half",
        "note": "code=2分の1地域メッシュ(JGD2011)、pop=令和2年国勢調査 人口総数、emp=令和3年経済センサス‐活動調査 従業者数、inRegion=対象地域内(1)/外周バッファ(0)",
        "code": pts["KEY_CODE"].astype(np.int64).tolist(),
        "pop": pts["pop"].tolist(),
        "emp": pts["emp"].tolist(),
        "inRegion": pts["in_region"].astype(int).tolist(),
    }
    size = write_json(PUBLIC_DATA / "zones.json", out)
    INTERIM.mkdir(parents=True, exist_ok=True)
    pts.drop(columns="geometry").to_csv(INTERIM / "zones.csv", index=False)

    inr = pts[pts["in_region"]]
    print(f"メッシュ数: {len(pts):,}（対象地域内 {len(inr):,} / 外周バッファ {len(pts) - len(inr):,}）")
    print(f"人口  対象地域内 {inr['pop'].sum():,} 人 / 最大 {pts['pop'].max():,} 人/メッシュ")
    print(f"従業者 対象地域内 {inr['emp'].sum():,} 人 / 最大 {pts['emp'].max():,} 人/メッシュ")
    print(f"秘匿地域フラグ（国勢調査 HTKSYORI=2、人口総数は公表値を使用）: {n_hidden:,} 件、人口が数値でない行: {n_pop_masked:,} 件、従業者が数値でない行: {n_emp_masked:,} 件")
    print(f"zones.json: {size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
