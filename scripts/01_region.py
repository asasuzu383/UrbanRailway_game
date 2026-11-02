"""対象地域ポリゴンの作成（N03 行政区域）。

1都3県（東京都の島しょ部を除く）＋ 茨城県南部の指定市町村を dissolve する。

出力:
  data/interim/region.gpkg       対象地域（layer=region）と外周バッファ（layer=region_buffer）
  public/data/region.geojson     表示用の簡略化した境界
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd
import pyogrio

from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, ksj_zip, load_config, vsizip


def read_n03(cfg: dict, pref: str) -> gpd.GeoDataFrame:
    z = ksj_zip(cfg, "N03", pref)
    inner = z.name.replace("_GML.zip", ".shp")
    return pyogrio.read_dataframe(vsizip(z, inner))


def main() -> None:
    cfg = load_config()
    rcfg = cfg["region"]
    parts = []

    for pref in rcfg["full_prefectures"]:
        gdf = read_n03(cfg, pref)
        cut = rcfg.get("exclude_codes_from", {}).get(pref)
        if cut is not None:
            # 例: 東京都の島しょ部（13361 大島町〜13421 小笠原村）
            drop = gdf["N03_007"].astype(int) >= int(cut)
            print(f"{pref}: 市区町村コード {cut} 以上を除外 {drop.sum()} ポリゴン")
            gdf = gdf[~drop]
        parts.append(gdf)

    for pref, names in (rcfg.get("partial_prefectures") or {}).items():
        gdf = read_n03(cfg, pref)
        wanted = set(names)
        missing = wanted - set(gdf["N03_004"].dropna())
        if missing:
            raise SystemExit(f"N03 に見つからない市町村（{pref}）: {sorted(missing)}")
        sel = gdf[gdf["N03_004"].isin(wanted)]
        print(f"{pref}: {sel['N03_004'].nunique()} 市町村 / {sel['N03_007'].nunique()} コード")
        parts.append(sel)

    muni = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=parts[0].crs).to_crs(CRS_METRIC)
    # N03 は頂点数が多く（約60万）そのままの union は非常に遅い。10m 簡略化してから結合し、
    # 簡略化で生じる市町村境界の細い隙間を ±30m のバッファで閉じる
    muni["geometry"] = muni.simplify(10)
    merged = muni.union_all().buffer(30, quad_segs=4).buffer(-30, quad_segs=4)
    region = gpd.GeoDataFrame(geometry=[merged], crs=CRS_METRIC)
    buffer = gpd.GeoDataFrame(geometry=region.simplify(100).buffer(rcfg["buffer_m"], quad_segs=4), crs=CRS_METRIC)
    area_km2 = region.area.iloc[0] / 1e6
    print(f"対象地域の面積: {area_km2:,.0f} km² / 市区町村ポリゴン {len(muni)}")

    INTERIM.mkdir(parents=True, exist_ok=True)
    out = INTERIM / "region.gpkg"
    out.unlink(missing_ok=True)
    region.to_file(out, layer="region")
    buffer.to_file(out, layer="region_buffer")
    muni[["N03_001", "N03_004", "N03_007", "geometry"]].to_file(out, layer="municipalities")

    display = region.simplify(200).to_crs(CRS_GEO)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    gpd.GeoDataFrame(geometry=display).to_file(
        PUBLIC_DATA / "region.geojson", driver="GeoJSON", COORDINATE_PRECISION=4
    )
    print(f"region.geojson: {(PUBLIC_DATA / 'region.geojson').stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
