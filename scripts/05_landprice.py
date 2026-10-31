"""地価公示（L01）のポイントを抽出する（任意データ。地平・高架の用地費推計用）。

出力: public/data/landprice.json  {"year": 2026, "points": [[lng, lat, 円/m², 用途区分], ...]}
用途区分（L01_002）: 000=住宅地, 003=宅地見込地, 005=商業地, 007=準工業地, 009=工業地, 010=調整区域内宅地, 013=現況林地 など
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd
import pyogrio

from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, ksj_zip, load_config, vsizip, write_json


def main() -> None:
    cfg = load_config()
    frames = []
    for pref in cfg["sources"]["N03_L01_prefectures"]:
        z = ksj_zip(cfg, "L01", pref)
        stem = z.name.replace("_GML.zip", "")
        frames.append(pyogrio.read_dataframe(vsizip(z, f"{stem}_GML/{stem}.geojson"),
                                             columns=["L01_002", "L01_007", "L01_008"]))
    pts = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs).to_crs(CRS_METRIC)
    buffer = gpd.read_file(INTERIM / "region.gpkg", layer="region_buffer").geometry.iloc[0]
    pts = pts[pts.within(buffer)].to_crs(CRS_GEO)

    year = int(pts["L01_007"].astype(int).max())
    points = [[round(g.x, 5), round(g.y, 5), int(p), str(u)]
              for g, p, u in zip(pts.geometry, pts["L01_008"].astype(int), pts["L01_002"])]
    size = write_json(PUBLIC_DATA / "landprice.json", {"version": 1, "year": year, "points": points})

    price = pts["L01_008"].astype(int)
    print(f"地価公示 {year}年: {len(points):,} 地点、中央値 {int(price.median()):,} 円/m²、最大 {int(price.max()):,} 円/m²")
    print("用途区分:", pts["L01_002"].value_counts().to_dict())
    print(f"landprice.json: {size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
