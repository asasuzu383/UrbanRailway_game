"""バックテスト（既存路線の再現検証）。docs/backtest.md、設定は scripts/config/backtest.yaml。

既存路線を「存在しなかったもの」としてネットワークから除き、同じ路線を新線として需要エンジンで推計して
S12 の乗降客数と比べる。手順:

  1. 除外: 対象路線の区間と、対象路線だけの駅を既存ネットワークから消す。他路線と共有する駅は他路線の駅として残す
  2. 新線の生成: N02 の線路形状・駅位置から、エディタで描く新線と同じ UserLine を作る（構造は設定ファイル）
  3. パラメータ: (a) 全駅で校正した値（src/config/demand.calibrated.json）、
                 (b) ホールドアウト = 除外後のネットワークで、対象路線の駅（共有駅を含む）を除いて校正し直した値
  4. 人口時点: 2020 年（通常）と、設定があれば 2000 年（開業前）
  5. 推計: tests/backtest/backtest.run.ts（ブラウザと同じ TypeScript のエンジン）を vitest で実行
  6. 評価: 駅別・路線全体の誤差と要因分析を docs/backtest_results.md と docs/backtest.results.json に書く

    .venv\\Scripts\\python.exe scripts\\backtest.py            # 全ケース
    .venv\\Scripts\\python.exe scripts\\backtest.py tx         # ケースを指定
    .venv\\Scripts\\python.exe scripts\\backtest.py --check    # 推計・評価だけやり直し、前回の結果との差を表示（回帰テスト）

--check でもホールドアウト校正はやり直す（モデルを変えたときの回帰確認が目的のため）。
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
import pyogrio
import yaml
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import substring

import calibrate as cal
from common import CRS_GEO, CRS_METRIC, INTERIM, PUBLIC_DATA, ROOT, ksj_zip, load_config, load_demand_config, vsizip

HERE = Path(__file__).resolve().parent
RESULTS_JSON = ROOT / "docs" / "backtest.results.json"
RESULTS_MD = ROOT / "docs" / "backtest_results.md"
STRUCTURE_LABEL = {"atGrade": "地平", "elevated": "高架", "underground": "地下"}


def import_script(name: str):
    """番号付きの前処理スクリプト（03_rail.py など）を関数の置き場として読み込む。"""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_backtest_config() -> dict:
    with (HERE / "config" / "backtest.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def dump(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. 除外
# ---------------------------------------------------------------------------

def target_line_ids(net: dict, keys: list[str]) -> set[int]:
    ids = {i for i, l in enumerate(net["lines"]) if f"{l['operator']}/{l['name']}" in keys}
    found = {f"{net['lines'][i]['operator']}/{net['lines'][i]['name']}" for i in ids}
    missing = set(keys) - found
    if missing:
        raise SystemExit(f"network.json に路線が見つかりません: {sorted(missing)}")
    return ids


def counterfactual(stations: list, net: dict, targets: set[int]) -> tuple[list, dict, set, set]:
    """対象路線を除いた駅一覧・ネットワーク。戻り値: (駅, ネットワーク, 消した駅 ID, 対象路線が乗り入れていたクラスタ)"""
    touched = {s["cluster"] for s in stations if set(s["lines"]) & targets}
    keep, removed = [], set()
    for s in stations:
        lines = [li for li in s["lines"] if li not in targets]
        if lines:
            keep.append({**s, "lines": lines})
        else:
            removed.add(s["id"])
    new_index = {s["id"]: i for i, s in enumerate(keep)}
    old_id = [s["id"] for s in stations]
    remap = lambda i: new_index.get(old_id[i])  # noqa: E731
    edges = [[remap(a), remap(b), li, d] for a, b, li, d in net["edges"]
             if li not in targets and remap(a) is not None and remap(b) is not None]
    walk = [[remap(a), remap(b), d] for a, b, d in net["walk"] if remap(a) is not None and remap(b) is not None]
    return keep, {**net, "edges": edges, "walk": walk}, removed, touched


# ---------------------------------------------------------------------------
# 人口
# ---------------------------------------------------------------------------

def zones_for(year: int, base: dict, cfg: dict) -> tuple[dict, dict]:
    """人口の時点を差し替えたゾーン（従業者は 2021 年のまま）。戻り値: (ゾーン, 集計情報)"""
    if year == 2020:
        return {"code": base["code"], "pop": base["pop"], "emp": base["emp"]}, {}
    if year != 2000:
        raise SystemExit(f"人口の時点 {year} には対応していません（2020, 2000）")
    zmod = import_script("02_zones")
    src = cfg["sources"]["census2000"]
    col = src["population_column"]
    df = zmod.read_estat_tables("census2000", src["stats_id"], cfg["primary_meshes"], ["KEY_CODE", col])
    df["pop"], n_masked = zmod.to_number(df[col])
    assert df["KEY_CODE"].str.len().eq(9).all(), "2分の1メッシュ以外のコードが混入"
    pop = dict(zip(df["KEY_CODE"].astype(np.int64), df["pop"]))
    codes = set(base["code"])
    in_region = np.asarray(base["inRegion"], bool)
    new_pop = np.array([pop.get(c, 0) for c in base["code"]], dtype=np.int64)
    base_pop = np.asarray(base["pop"], np.int64)
    # 2000 年に人がいたが 2020 年には人口・従業者とも 0 でゾーンに無いメッシュ（対象地域外を含む）
    lost = sum(v for c, v in pop.items() if c not in codes)
    info = {
        "regionPop2000": int(new_pop[in_region].sum()),
        "regionPop2020": int(base_pop[in_region].sum()),
        "masked": n_masked,
        "popNotInZones": int(lost),
    }
    print(f"2000年人口: 対象地域内 {info['regionPop2000']:,} 人（2020年 {info['regionPop2020']:,} 人）、"
          f"数値でない値 {n_masked} 件、2020年のゾーンに無いメッシュの人口 {lost:,} 人（対象地域外を含む）")
    return {"code": base["code"], "pop": new_pop.tolist(), "emp": base["emp"]}, info


# ---------------------------------------------------------------------------
# 2. 新線の生成
# ---------------------------------------------------------------------------

def build_line(case: dict, sec, st_n02, base_st: dict, cf_ids: set) -> tuple[dict, list]:
    """N02 の線路形状と駅から UserLine を作る。戻り値: (UserLine, 駅のメタ情報)"""
    keys = case["lines"]
    s = sec[sec["line_key"].isin(keys)]
    t = st_n02[st_n02["line_key"].isin(keys)]
    g = nx.Graph()
    key = lambda xy: (round(xy[0] * 10), round(xy[1] * 10))  # noqa: E731 — 03_rail.py と同じ 10cm 単位
    for geom in list(s.geometry) + list(t.geometry):
        c = list(geom.coords)
        a, b = key(c[0]), key(c[-1])
        if a != b and (not g.has_edge(a, b) or g[a][b]["w"] > geom.length):
            g.add_edge(a, b, w=geom.length, coords=c)
    # 路線どうしの継ぎ目（例: 相鉄と東急の新横浜）で端点が一致しないときは、最も近い端点どうしを直線でつなぐ
    comps = [list(c) for c in nx.connected_components(g)]
    while len(comps) > 1:
        a_nodes = np.array(comps[0], dtype=float)
        best_link = None
        for ci in range(1, len(comps)):
            b_nodes = np.array(comps[ci], dtype=float)
            d = np.hypot(a_nodes[:, None, 0] - b_nodes[None, :, 0], a_nodes[:, None, 1] - b_nodes[None, :, 1]) / 10
            k = np.unravel_index(np.argmin(d), d.shape)
            if best_link is None or d[k] < best_link[0]:
                best_link = (d[k], comps[0][k[0]], comps[ci][k[1]])
        dist_m, u, v = best_link
        if dist_m > 500:
            raise SystemExit(f"{case['id']}: 線路形状が {dist_m:.0f} m 途切れています")
        g.add_edge(u, v, w=dist_m, coords=[(u[0] / 10, u[1] / 10), (v[0] / 10, v[1] / 10)])
        print(f"{case['id']}: 線路形状の継ぎ目を {dist_m:.0f} m の直線でつないだ")
        comps = [list(c) for c in nx.connected_components(g)]
    ends = {}
    for name in case["termini"]:
        rows = t[t["name"] == name]
        if rows.empty:
            raise SystemExit(f"{case['id']}: 起終点 {name} が対象路線の駅にありません")
        c = list(rows.geometry.iloc[0].coords)
        ends[name] = [key(c[0]), key(c[-1])]
    best = None
    for a in ends[case["termini"][0]]:
        for b in ends[case["termini"][1]]:
            try:
                d, path = nx.single_source_dijkstra(g, a, b, weight="w")
            except nx.NetworkXNoPath:
                continue
            if best is None or d < best[0]:
                best = (d, path)
    if best is None:
        raise SystemExit(f"{case['id']}: 起点から終点まで線路がつながっていません")
    coords: list = []
    for u, v in zip(best[1][:-1], best[1][1:]):
        c = g[u][v]["coords"]
        if key(c[0]) != u:
            c = c[::-1]
        coords.extend(c if not coords else c[1:])
    path = LineString(coords)

    # 駅: N02 の駅グループ単位（2 路線に同じ駅があれば 1 つにまとめる）。位置は駅グループの代表点
    tr_to_m = Transformer.from_crs(CRS_GEO, CRS_METRIC, always_xy=True)
    tr_to_geo = Transformer.from_crs(CRS_METRIC, CRS_GEO, always_xy=True)
    groups = t.drop_duplicates("group")
    stops = []
    for _, r in groups.iterrows():
        b = base_st[r["group"]]
        x, y = tr_to_m.transform(b["lng"], b["lat"])
        stops.append({"group": r["group"], "name": r["name"], "lng": b["lng"], "lat": b["lat"],
                      "chainage": path.project(Point(x, y)), "transfer": r["group"] in cf_ids})
    stops.sort(key=lambda x: x["chainage"])

    # 区間の構造
    names = [x["name"] for x in stops]
    structures: list = [None] * (len(stops) - 1)
    notes: list = [None] * (len(stops) - 1)
    for spec in case.get("structures", []):
        i, j = names.index(spec["from"]), names.index(spec["to"])
        for k in range(min(i, j), max(i, j)):
            structures[k] = spec["structure"]
            notes[k] = spec.get("note")
    for k in range(len(structures)):
        if structures[k] is None:
            structures[k] = "elevated"
            notes[k] = "仮置き（設定なし）"

    vertices = []
    for i, x in enumerate(stops):
        vertices.append({"kind": "station", "id": f"s{i}", "position": [x["lng"], x["lat"]], "name": x["name"],
                         "transferTo": x["group"] if x["transfer"] else None})
        if i + 1 < len(stops):
            part = substring(path, x["chainage"], stops[i + 1]["chainage"]).simplify(20)
            for j, (px, py) in enumerate(list(part.coords)[1:-1]):
                lng, lat = tr_to_geo.transform(px, py)
                vertices.append({"kind": "shape", "id": f"p{i}_{j}", "position": [round(lng, 6), round(lat, 6)]})
    line = {
        "id": f"backtest-{case['id']}",
        "name": case["name"],
        "color": case.get("color", "#333333"),
        "vertices": vertices,
        "segments": [{"fromStationId": f"s{i}", "structure": structures[i]} for i in range(len(stops) - 1)],
    }
    meta = [{"vertexId": f"s{i}", "name": x["name"], "group": x["group"], "transfer": x["transfer"],
             "structureToNext": structures[i] if i < len(structures) else None,
             "structureNote": notes[i] if i < len(notes) else None} for i, x in enumerate(stops)]
    print(f"{case['id']}: 新線 {len(stops)} 駅（接続駅 {sum(x['transfer'] for x in stops)}）、線路延長 {path.length / 1000:.1f} km")
    return line, meta


# ---------------------------------------------------------------------------
# 実績値（S12）
# ---------------------------------------------------------------------------

def year_cols(year: int) -> tuple[str, str, str, str]:
    base = 6 + 4 * (year - 2011)
    return tuple(f"S12_{base + i:03d}" for i in range(4))


def load_s12(cfg: dict) -> pd.DataFrame:
    z = ksj_zip(cfg, "S12")
    stem = cfg["sources"]["S12"]["version"]
    s12 = pyogrio.read_dataframe(vsizip(z, f"{stem}_GML/UTF-8/{stem}_NumberOfPassengers.geojson"), read_geometry=False)
    s12 = s12.rename(columns={"S12_001": "name", "S12_001c": "code", "S12_002": "operator", "S12_003": "line"})
    s12["line_key"] = s12["operator"] + "/" + s12["line"]
    return s12


def s12_years(s12: pd.DataFrame) -> list[int]:
    """S12 に収録されている年度（2011 年度から 4 列ずつ）"""
    years = []
    y = 2011
    while year_cols(y)[3] in s12.columns:
        years.append(y)
        y += 1
    return years


def actuals(case: dict, meta: list, s12: pd.DataFrame, code_to_group: dict, years: list[int]) -> dict:
    """新線の駅ごとの実績（対象路線の S12 行）。推測では埋めず、取れない駅は理由を付けて None にする。"""
    rows = s12[s12["line_key"].isin(case["lines"])].copy()
    rows["group"] = rows["code"].map(code_to_group)
    line_names = [k.split("/")[1] for k in case["lines"]]
    out = {}
    for m in meta:
        r = rows[rows["group"] == m["group"]]
        per_year = {}
        for y in years:
            dup, exist, note, val = year_cols(y)
            if r.empty:
                per_year[str(y)] = {"value": None, "status": "no_row", "note": "S12 に対象路線の行がない"}
                continue
            d = r[dup].astype(str)
            e = r[exist].astype(str)
            notes = r[note].fillna("").astype(str)
            v = pd.to_numeric(r[val], errors="coerce").fillna(0) * np.where(notes.str.contains("乗車人員"), 2, 1)
            valid = (d == "1") & (e == "1")
            text = "、".join(sorted({n for n in notes if n}))
            if valid.any():
                others = [n for n in notes[valid] if "を含む" in n and not any(ln in n for ln in line_names)]
                status = "includes_other" if others else "ok"
                per_year[str(y)] = {"value": int(round(float(v[valid].sum()))), "status": status, "note": text}
            elif (d == "3").all() or (e == "4").all():
                per_year[str(y)] = {"value": None, "status": "not_open", "note": text or "駅なし（未開業）"}
            elif (d == "2").all():
                per_year[str(y)] = {"value": None, "status": "merged",
                                    "note": "他路線の駅の行に合算されていて分けられない" + (f"（{text}）" if text else "")}
            else:
                per_year[str(y)] = {"value": None, "status": "missing", "note": text or "データなし・非公開"}
        out[m["vertexId"]] = per_year
    return out


def opening_years(case: dict, s12: pd.DataFrame, years: list[int]) -> dict:
    """対象路線の各駅について、S12 に初めて値が載った年度（開業年度の確認用）"""
    rows = s12[s12["line_key"].isin(case["lines"])]
    out = {}
    for _, r in rows.iterrows():
        first = next((y for y in years if str(r[year_cols(y)[0]]) != "3" and str(r[year_cols(y)[1]]) != "4"), None)
        note = r[year_cols(first)[2]] if first else None
        out[f"{r['operator']} {r['name']}"] = {"firstYear": first, "note": "" if note is None or pd.isna(note) else str(note)}
    return out


# ---------------------------------------------------------------------------
# 3. パラメータ・駅データ
# ---------------------------------------------------------------------------

def fitted_from_calibration(res_x, glm) -> dict:
    p = cal.unpack(res_x)
    coef = dict(zip(["intercept", "catchmentElasticity", "accessibilityElasticity", "hubElasticity"], glm.params))
    return {**p, **{k: float(v) for k, v in coef.items()}}


def holdout_calibration(dcfg: dict, zones: dict, st_cf: list, net_cf: dict, touched: set) -> dict:
    psi = dcfg["mass"]["population_weight"]
    inp = cal.load_inputs(dcfg, zones, st_cf, net_cf, verbose=False)
    excluded: list = []
    obs = cal.build_obs(inp, dcfg["calibration"]["year"], dcfg, excluded, holdout_clusters=touched)
    n_holdout = sum(1 for _, r in excluded if r == "バックテスト対象路線の駅")
    print(f"ホールドアウト校正: {len(obs.y):,} 駅（対象路線の駅 {n_holdout} クラスタを除外）")
    res, n_eval = cal.fit_nonlinear(inp, obs, psi, cal.BOUNDS, verbose=False)
    p = cal.unpack(res.x)
    glm = cal.fit_glm(obs.y, cal.design(cal.model_terms(inp, p, psi), obs, p["employeeWeight"]), robust=True)
    fitted = fitted_from_calibration(res.x, glm)
    m = cal.metrics(obs.y, glm.fittedvalues)
    return {"fitted": fitted, "metrics": m, "nEval": n_eval, "converged": bool(res.success), "nHoldoutClusters": n_holdout}


def station_file(inp, st: list, fitted: dict, psi: float) -> list:
    p = {k: fitted[k] for k in cal.PARAM_NAMES}
    outs = cal.station_outputs(inp, p, fitted, psi)
    return [{"id": s["id"], "name": s["name"], "lng": s["lng"], "lat": s["lat"],
             "acc": float(outs["acc"][i]), "mass": float(outs["mass"][i]), "catch": float(outs["catch"][i]),
             "muCatch": float(outs["muCatch"][i])} for i, s in enumerate(st)]


def in_sample_fit(dcfg: dict, base_inp, fitted: dict, meta: list) -> dict:
    """段階 A: 対象路線が既存線として存在する世界で、全駅校正の駅モデル（路線数の項を含む）が対象路線の単独駅をどう当てるか。
    単独駅（接続駅でない駅）だけが比べられる（共有駅の S12 は駅全体の値なので）。"""
    psi = dcfg["mass"]["population_weight"]
    p = {k: fitted[k] for k in cal.PARAM_NAMES}
    terms = cal.model_terms(base_inp, p, psi)
    idx = {s["id"]: i for i, s in enumerate(base_inp.stations)}
    out = {}
    for m in meta:
        if m["transfer"]:
            continue
        i = idx[m["group"]]
        x = terms.catch_pop[i] + p["employeeWeight"] * terms.catch_emp[i]
        lin = fitted["intercept"] + fitted["catchmentElasticity"] * np.log(max(x, 1.0)) \
            + fitted["accessibilityElasticity"] * np.log(max(terms.acc[i], 1.0) / cal.ACC_REF) \
            + fitted["hubElasticity"] * np.log(max(1, len(base_inp.stations[i]["lines"])))
        out[m["vertexId"]] = {"mu": float(np.exp(lin)), "catchment": float(x), "acc": float(terms.acc[i])}
    return out


# ---------------------------------------------------------------------------
# 準備（1〜3）
# ---------------------------------------------------------------------------

def prepare(cases: list, bcfg: dict) -> dict:
    cfg = load_config()
    dcfg = load_demand_config()
    psi = dcfg["mass"]["population_weight"]
    work = ROOT / bcfg["work_dir"]
    base_zones = json.loads((PUBLIC_DATA / "zones.json").read_text(encoding="utf-8"))
    stations = json.loads((PUBLIC_DATA / "stations.json").read_text(encoding="utf-8"))["stations"]
    net = json.loads((PUBLIC_DATA / "network.json").read_text(encoding="utf-8"))
    calibrated = json.loads((ROOT / "src" / "config" / "demand.calibrated.json").read_text(encoding="utf-8"))
    members = pd.read_csv(INTERIM / "station_members.csv", dtype={"code": str, "group": str})
    code_to_group = dict(zip(members["code"], members["group"]))
    rail = import_script("03_rail")
    sec, st_n02 = rail.read_n02(cfg)
    s12 = load_s12(cfg)
    years = s12_years(s12)
    base_by_id = {s["id"]: s for s in stations}
    print("全駅のネットワークで校正値の当てはまりを計算（段階 A）")
    base_inp = cal.load_inputs(dcfg, base_zones, stations, net, verbose=False)

    manifest = {"createdAt": dt.datetime.now().isoformat(timespec="seconds"), "cases": []}
    meta_all = {}
    for case in cases:
        t0 = time.time()
        cdir = work / case["id"]
        targets = target_line_ids(net, case["lines"])
        st_cf, net_cf, removed, touched = counterfactual(stations, net, targets)
        cf_ids = {s["id"] for s in st_cf}
        print(f"\n=== {case['id']}: {case['name']} ===")
        print(f"除外: 路線 {len(targets)}、単独駅 {len(removed)}、対象路線が乗り入れる乗降集計クラスタ {len(touched)}")

        line, meta = build_line(case, sec, st_n02, base_by_id, cf_ids)
        dump(cdir / "line.json", line)
        dump(cdir / "scenario.json", {"schemaVersion": 1, "lines": [line]})

        zones_by_year = {}
        pop_info = {}
        for y in case["populations"]:
            zones_by_year[y], pop_info[str(y)] = zones_for(y, base_zones, cfg)
            dump(cdir / f"zones_{y}.json", zones_by_year[y])

        inp_by_year = {y: cal.load_inputs(dcfg, zones_by_year[y], st_cf, net_cf, verbose=False) for y in case["populations"]}
        (cdir / "times.bin").write_bytes(cal.pack_times(inp_by_year[case["populations"][0]].times))

        holdout = holdout_calibration(dcfg, zones_by_year[2020], st_cf, net_cf, touched)
        param_sets = {"full": calibrated["fitted"], "holdout": holdout["fitted"]}

        speed = bcfg["speed"]
        if speed == "network":
            speed = float(np.mean([net["lines"][i]["speedKmh"] for i in targets]))
        speeds = [speed] + [s for s in bcfg.get("sensitivity_speeds", []) if s != speed]

        variants = []
        for ps_name, fitted in param_sets.items():
            for y in case["populations"]:
                sfile = cdir / f"stations_{ps_name}_{y}.json"
                dump(sfile, station_file(inp_by_year[y], st_cf, fitted, psi))
                for sp in speeds:
                    # 感度分析（速度）は全駅校正・2020 年人口だけで回す
                    if sp != speed and not (ps_name == "full" and y == 2020):
                        continue
                    vid = f"{ps_name}-{y}-{sp:g}kmh"
                    pfile = cdir / f"params_{ps_name}_{sp:g}.json"
                    dump(pfile, {**calibrated, "fitted": fitted,
                                 "service": {**calibrated["service"], "scheduledSpeedKmh": sp}})
                    variants.append({"id": vid, "population": y, "speedKmh": sp,
                                     "main": sp == speed,
                                     "stations": rel(sfile), "zones": rel(cdir / f"zones_{y}.json"),
                                     "params": rel(pfile), "paramSet": ps_name,
                                     "out": rel(cdir / "results" / f"{vid}.json")})
        act = actuals(case, meta, s12, code_to_group, years)
        stage_a = in_sample_fit(dcfg, base_inp, calibrated["fitted"], meta)
        base_catch = {m["vertexId"]: base_by_id[m["group"]].get("catch") for m in meta}
        info = {"case": case, "meta": meta, "actuals": act, "openingYears": opening_years(case, s12, years),
                "stageA": stage_a, "baseCatch": base_catch, "holdout": holdout, "population": pop_info,
                "speedKmh": speed, "removedStations": len(removed), "touchedClusters": len(touched),
                "fullMetrics": calibrated["metrics"], "fullFitted": calibrated["fitted"]}
        dump(cdir / "info.json", info)
        meta_all[case["id"]] = info
        manifest["cases"].append({"id": case["id"], "line": rel(cdir / "line.json"), "times": rel(cdir / "times.bin"),
                                  "info": rel(cdir / "info.json"), "variants": variants})
        print(f"{case['id']}: 準備 {time.time() - t0:.0f}s、推計ケース {len(variants)}")
    dump(work / "manifest.json", manifest)
    return manifest


# ---------------------------------------------------------------------------
# 5. 推計（TypeScript）
# ---------------------------------------------------------------------------

def run_engine() -> None:
    cmd = "npx vitest run --config vitest.backtest.config.ts"
    print(f"\n> {cmd}")
    r = subprocess.run(cmd, cwd=ROOT, shell=True)
    if r.returncode != 0:
        raise SystemExit(f"推計（vitest）が失敗しました（終了コード {r.returncode}）")


# ---------------------------------------------------------------------------
# 6. 評価
# ---------------------------------------------------------------------------

def metrics(pred: np.ndarray, act: np.ndarray) -> dict:
    if len(act) == 0:
        return {"n": 0}
    le = np.log(np.maximum(pred, 1e-9) / act)
    return {
        "n": int(len(act)),
        "predSum": float(pred.sum()),
        "actualSum": float(act.sum()),
        "totalRatio": float(pred.sum() / act.sum()),
        "mape": float(np.mean(np.abs(pred - act) / act)),
        "meanLogError": float(le.mean()),
        "sdLogError": float(le.std(ddof=1)) if len(le) > 1 else 0.0,
        "medianRatio": float(np.exp(np.median(le))),
        "within2x": float(np.mean(np.abs(le) <= np.log(2))),
    }


def evaluate(manifest: dict, bcfg: dict) -> dict:
    year = str(bcfg["primary_year"])
    out = {"generatedAt": dt.datetime.now().isoformat(timespec="seconds"), "primaryYear": int(year), "cases": {}}
    for c in manifest["cases"]:
        info = json.loads((ROOT / c["info"]).read_text(encoding="utf-8"))
        act = info["actuals"]
        res = {}
        for v in c["variants"]:
            r = json.loads((ROOT / v["out"]).read_text(encoding="utf-8"))
            stops = {s["vertexId"]: s for s in r["stops"]}
            rows = []
            for m in info["meta"]:
                a = act[m["vertexId"]][year]
                s = stops[m["vertexId"]]
                rows.append({"vertexId": m["vertexId"], "name": m["name"], "transfer": m["transfer"],
                             "pred": s["ridership"], "actual": a["value"], "status": a["status"],
                             "fromCatchment": s["fromCatchment"], "fromTransfer": s["fromTransfer"],
                             "fromThrough": s["fromThrough"],
                             "tripEnds": s["tripEnds"], "catchment": s["catchment"], "acc": s["acc"]})
            df = pd.DataFrame(rows)
            ok = df["status"].eq("ok") & df["actual"].notna()
            okx = df["status"].isin(["ok", "includes_other"]) & df["actual"].notna()
            pick = lambda mask: metrics(df.loc[mask, "pred"].to_numpy(float), df.loc[mask, "actual"].to_numpy(float))  # noqa: E731
            # 診断: 経路転換（既存線どうしの短絡利用）を除いた乗降で同じ指標を計算する
            no_through = df["pred"] - df["fromThrough"]
            m_nt = metrics(no_through[ok].to_numpy(float), df.loc[ok, "actual"].to_numpy(float))
            res[v["id"]] = {
                "metricsWithoutThrough": m_nt,
                "params": v["paramSet"], "population": v["population"], "speedKmh": v["speedKmh"], "main": v["main"],
                "stations": rows,
                "metrics": pick(ok),
                "metricsInclNoted": pick(okx),
                "metricsFresh": pick(ok & ~df["transfer"]),
                "metricsTransfer": pick(ok & df["transfer"]),
                "dailyPassengers": r["dailyPassengers"], "dailyPassengerKm": r["dailyPassengerKm"],
                "tripsByType": r["tripsByType"], "totalKm": r["totalKm"],
            }
        out["cases"][c["id"]] = {"info": {k: info[k] for k in ("case", "meta", "openingYears", "stageA", "baseCatch",
                                                                  "holdout", "population", "speedKmh", "fullFitted",
                                                                  "removedStations", "touchedClusters", "fullMetrics")},
                                 "actuals": act, "variants": res}
    return out


def check_against_previous(new: dict) -> None:
    if not RESULTS_JSON.exists():
        print("前回の結果（docs/backtest.results.json）がないので比較しない")
        return
    old = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
    print("\n前回の結果との比較（合計比 / 対数誤差の平均）")
    for cid, c in new["cases"].items():
        for vid, v in c["variants"].items():
            o = old.get("cases", {}).get(cid, {}).get("variants", {}).get(vid)
            m = v["metrics"]
            if not o:
                print(f"  {cid}/{vid}: 新規 {m['totalRatio']:.3f} / {m['meanLogError']:+.3f}")
                continue
            om = o["metrics"]
            flag = "" if abs(m["totalRatio"] - om["totalRatio"]) < 1e-3 and abs(m["meanLogError"] - om["meanLogError"]) < 1e-3 else "  ← 変化"
            print(f"  {cid}/{vid}: {om['totalRatio']:.3f} → {m['totalRatio']:.3f} / {om['meanLogError']:+.3f} → {m['meanLogError']:+.3f}{flag}")


# ---------------------------------------------------------------------------
# レポート
# ---------------------------------------------------------------------------

STATUS_LABEL = {"ok": "", "includes_other": "他路線を含む", "merged": "比較不可（他路線と合算）", "not_open": "未開業",
                "missing": "データなし", "no_row": "行なし"}
PARAM_LABEL = {"full": "全駅校正", "holdout": "ホールドアウト"}


def fmt(x, d=0) -> str:
    return "—" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:,.{d}f}"


def write_results_md(res: dict, bcfg: dict) -> None:
    y = res["primaryYear"]
    L = []
    w = L.append
    w("# バックテスト結果（自動生成）")
    w("")
    w(f"生成: `scripts/backtest.py`（{res['generatedAt'][:10]}）。考察は [backtest.md](backtest.md)。実績は S12 の {y} 年度の乗降客数（人/日）。")
    w("比率 = 予測 / 実績、対数誤差 = ln(予測 / 実績)。指標は「比較可能」な駅（他路線との合算・他路線を含む値を除く）で計算した。")
    w("")
    for cid, c in res["cases"].items():
        info = c["info"]
        case = info["case"]
        w(f"## {case['name']}（`{cid}`）")
        w("")
        w(f"- 除外した路線: {', '.join(case['lines'])}（単独駅 {info['removedStations']}、対象路線が乗り入れる乗降集計クラスタ {info['touchedClusters']}）")
        w(f"- 新線の表定速度: {info['speedKmh']:g} km/h（既存ネットワークでの同路線の設定）。感度分析は {', '.join(str(s) for s in bcfg.get('sensitivity_speeds', []))} km/h")
        h = info["holdout"]
        hm = h["metrics"]
        w(f"- ホールドアウト校正: {hm['n']:,} 駅（対象路線の {h['nHoldoutClusters']} クラスタを除外）、疑似 R² {hm['pseudoR2']:.3f}、対数 R² {hm['logR2']:.3f}、収束 {h['converged']}")
        if info["population"].get("2000"):
            p = info["population"]["2000"]
            w(f"- 2000 年人口（対象地域内）: {p['regionPop2000']:,} 人（2020 年 {p['regionPop2020']:,} 人）。従業者は 2021 年のまま")
        w("")
        w("### パラメータ（全駅校正とホールドアウト）")
        w("")
        names = [("accessDecayPerKm", "β 駅までの距離減衰"), ("attractivenessExponent", "α 魅力度指数"), ("outsideConst", "a₀ 外部選択肢"),
                 ("outsidePerKm", "a₁ 外部選択肢の都心距離係数"), ("employeeWeight", "ρ 従業者の重み"), ("timeDecayPerMin", "γ 所要時間の減衰"),
                 ("intercept", "c₀ 切片"), ("catchmentElasticity", "η 駅勢圏の弾力性"), ("accessibilityElasticity", "θ ACC の弾力性"),
                 ("hubElasticity", "κ 路線数の弾力性")]
        w("| パラメータ | 全駅校正 | ホールドアウト |")
        w("|---|---|---|")
        for k, label in names:
            w(f"| {label} | {info['fullFitted'][k]:.4f} | {h['fitted'][k]:.4f} |")
        w("")
        w("### 推計ケースと路線全体の指標")
        w("")
        w("| ケース | パラメータ | 人口 | 速度 | 駅数 | 予測合計 | 実績合計 | 合計比 | MAPE | 対数誤差 平均 | 対数誤差 SD | 2倍以内 | 新駅の合計比 | 接続駅の合計比 | 経路転換を除く合計比 |")
        w("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for vid, v in c["variants"].items():
            m, mf, mt = v["metrics"], v["metricsFresh"], v["metricsTransfer"]
            w(f"| `{vid}` | {PARAM_LABEL[v['params']]} | {v['population']} | {v['speedKmh']:g} | {m['n']} | {fmt(m['predSum'])} | {fmt(m['actualSum'])} | "
              f"{m['totalRatio']:.2f} | {m['mape']:.0%} | {m['meanLogError']:+.2f} | {m['sdLogError']:.2f} | {m['within2x']:.0%} | "
              f"{fmt(mf.get('totalRatio'), 2)} | {fmt(mt.get('totalRatio'), 2)} | {v['metricsWithoutThrough']['totalRatio']:.2f} |")
        w("")
        # 駅別
        vids = list(c["variants"])
        main_ids = [vid for vid in vids if c["variants"][vid]["main"]]
        w("### 駅別（予測は主なケース）")
        w("")
        head = "| 駅 | 種別 | 実績 " + str(y) + " | " + " | ".join(f"`{v}`" for v in main_ids) + " | 比率（" + main_ids[0] + "） | 対数誤差 | 備考 |"
        w(head)
        w("|" + "---|" * (6 + len(main_ids)))
        first = c["variants"][main_ids[0]]["stations"]
        for i, srow in enumerate(first):
            a = srow["actual"]
            preds = [c["variants"][v]["stations"][i]["pred"] for v in main_ids]
            ratio = preds[0] / a if a else None
            le = np.log(preds[0] / a) if a and preds[0] > 0 else None
            w(f"| {srow['name']} | {'接続駅' if srow['transfer'] else '新駅'} | {fmt(a)} | " + " | ".join(fmt(p) for p in preds)
              + f" | {fmt(ratio, 2)} | {('—' if le is None else f'{le:+.2f}')} | {STATUS_LABEL.get(srow['status'], srow['status'])} |")
        w("")
        # 要因分析
        fv = c["variants"][main_ids[0]]
        w(f"### 要因分析（`{main_ids[0]}`）")
        w("")
        w("段階 A = 対象路線が既存線として存在する世界での駅モデル（全駅校正、路線数の項込み）の当てはまり。新駅のみ。")
        w("駅勢圏 X は人口＋ρ×従業者（Huff 按分後）。μ は駅勢圏由来の乗降（発生・集中）、乗降 = 分布後に新線を使う人数。")
        w("")
        w("| 駅 | 種別 | 実績 | 段階A μ | 段階A X | 新線推計 X | 新線推計 μ | 乗降（駅勢圏） | 乗降（乗換: 新駅方面） | 乗降（乗換: 経路転換） | 乗降 / μ |")
        w("|---|---|---|---|---|---|---|---|---|---|---|")
        for srow in fv["stations"]:
            sa = info["stageA"].get(srow["vertexId"])
            w(f"| {srow['name']} | {'接続駅' if srow['transfer'] else '新駅'} | {fmt(srow['actual'])} | {fmt(sa['mu'] if sa else None)} | "
              f"{fmt(sa['catchment'] if sa else None)} | {fmt(srow['catchment'] if not srow['transfer'] else None)} | {fmt(srow['tripEnds'])} | "
              f"{fmt(srow['fromCatchment'])} | {fmt(srow['fromTransfer'] - srow['fromThrough'])} | {fmt(srow['fromThrough'])} | "
              f"{fmt(srow['pred'] / srow['tripEnds'] if srow['tripEnds'] > 0 else None, 2)} |")
        w("")
        tb = fv["tripsByType"]
        w(f"輸送人員 {fmt(fv['dailyPassengers'])} 人/日（新線内 {fmt(tb['local'])} / 既存線と乗継 {fmt(tb['toExisting'])} / 既存線からの経路転換 {fmt(tb['through'])}）、"
          f"輸送人キロ {fmt(fv['dailyPassengerKm'])}、営業キロ（推計上）{fv['totalKm']:.1f} km。")
        w("")
        w("### 実績値の年度")
        w("")
        w("| 事業者・駅 | S12 に初めて値がある年度 | 備考 |")
        w("|---|---|---|")
        for k, o in info["openingYears"].items():
            w(f"| {k} | {o['firstYear'] or '—'} | {o['note']} |")
        w("")
        w("### 区間の構造（新線の生成に使った値）")
        w("")
        w("| 区間 | 構造 | 備考 |")
        w("|---|---|---|")
        meta = info["meta"]
        for i in range(len(meta) - 1):
            w(f"| {meta[i]['name']}〜{meta[i + 1]['name']} | {STRUCTURE_LABEL[meta[i]['structureToNext']]} | {meta[i]['structureNote'] or ''} |")
        w("")
    RESULTS_MD.write_text("\n".join(L), encoding="utf-8", newline="\n")


def main(argv: list[str]) -> int:
    check = "--check" in argv
    ids = [a for a in argv if not a.startswith("--")]
    bcfg = load_backtest_config()
    cases = [c for c in bcfg["cases"] if not ids or c["id"] in ids]
    if not cases:
        raise SystemExit(f"ケースが見つかりません: {ids}")
    manifest = prepare(cases, bcfg)
    run_engine()
    res = evaluate(manifest, bcfg)
    check_against_previous(res)
    if check:
        return 0
    if ids and RESULTS_JSON.exists():
        # 一部のケースだけ回したときは他のケースの前回結果を残す
        old = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
        res["cases"] = {**{k: v for k, v in old["cases"].items() if k not in res["cases"]}, **res["cases"]}
    RESULTS_JSON.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    write_results_md(res, bcfg)
    print(f"\n書き出し: {rel(RESULTS_JSON)}, {rel(RESULTS_MD)}")
    for cid, c in res["cases"].items():
        for vid, v in c["variants"].items():
            m = v["metrics"]
            print(f"  {cid}/{vid}: 合計比 {m['totalRatio']:.2f}、MAPE {m['mape']:.0%}、対数誤差 {m['meanLogError']:+.2f}±{m['sdLogError']:.2f}（{m['n']} 駅）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
