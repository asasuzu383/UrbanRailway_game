"""需要モデルの校正（docs/design.md §4, §5）。

既存駅に「外部選択肢付き Huff ＋ 重力型アクセシビリティ」の駅勢圏モデルを当てはめ、
S12 の乗降客数に対してポアソン疑似最尤法（PPML）でパラメータを推定する。

  - 線形部分（切片・弾力性）: 対数リンクのポアソン GLM（statsmodels）
  - 非線形部分（距離減衰・魅力度指数・外部選択肢・従業者の重み・時間減衰）:
    GLM の逸脱度を目的関数として Nelder–Mead で外側から最適化（profile likelihood）

出力:
  src/config/demand.calibrated.json   ブラウザの需要エンジンが読むパラメータ（固定値＋校正値）
  public/data/stations.json           各駅に acc（ACC）・mass（集中量 M）・muCatch（駅勢圏由来の乗降推計）を追記
  docs/calibration.md                 校正結果の報告
  data/interim/calibration_stations.csv  駅別の観測値・推計値（検証用）

    .venv\\Scripts\\python.exe scripts\\calibrate.py
"""

from __future__ import annotations

import datetime as dt
import json
import time
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
import statsmodels.api as sm
from pyproj import Transformer
from scipy.optimize import minimize
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from common import CRS_METRIC, INTERIM, PUBLIC_DATA, ROOT, half_mesh_centroid, load_config, load_demand_config

warnings.filterwarnings("ignore", category=RuntimeWarning)
ACC_REF = 1e6  # ACC の基準化定数（魅力度 A = (ACC/ACC_REF)^α）
CORE = (139.7671, 35.6812)


def haversine_km(lng1, lat1, lng2, lat2):
    r = 6371.0088
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dlat = p2 - p1
    dlng = np.radians(np.asarray(lng2) - np.asarray(lng1))
    h = np.sin(dlat / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlng / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(np.minimum(1, h)))


# ---------------------------------------------------------------------------
# データ準備
# ---------------------------------------------------------------------------

@dataclass
class Inputs:
    pop: np.ndarray
    emp: np.ndarray
    dist_core: np.ndarray
    pair_z: np.ndarray  # ゾーン-駅ペア（アクセス距離が上限以内）
    pair_s: np.ndarray
    pair_d: np.ndarray  # 道のり換算のアクセス距離 [km]
    times: np.ndarray   # 駅間の最短所要時間 [分]（到達不能は inf）
    stations: list
    n_lines: np.ndarray
    tram_only: np.ndarray  # 路面電車（鉄道区分 21 = 軌道）の路線だけが乗り入れる駅


def load_inputs(dcfg: dict) -> Inputs:
    zones = json.loads((PUBLIC_DATA / "zones.json").read_text(encoding="utf-8"))
    st = json.loads((PUBLIC_DATA / "stations.json").read_text(encoding="utf-8"))["stations"]
    net = json.loads((PUBLIC_DATA / "network.json").read_text(encoding="utf-8"))

    zlng, zlat = half_mesh_centroid(zones["code"])
    pop = np.asarray(zones["pop"], float)
    emp = np.asarray(zones["emp"], float)
    dist_core = haversine_km(CORE[0], CORE[1], zlng, zlat)

    slng = np.array([s["lng"] for s in st])
    slat = np.array([s["lat"] for s in st])
    tr = Transformer.from_crs("EPSG:4326", CRS_METRIC, always_xy=True)
    zx, zy = tr.transform(zlng, zlat)
    sx, sy = tr.transform(slng, slat)

    detour = dcfg["access"]["detour_factor"]
    max_km = dcfg["access"]["max_access_km"]
    tree = cKDTree(np.c_[sx, sy])
    neigh = tree.query_ball_point(np.c_[zx, zy], r=max_km / detour * 1000)
    pz = np.repeat(np.arange(len(neigh)), [len(n) for n in neigh])
    ps = np.concatenate([np.asarray(n, dtype=int) for n in neigh]) if len(pz) else np.array([], int)
    pdist = np.hypot(zx[pz] - sx[ps], zy[pz] - sy[ps]) / 1000 * detour

    times = travel_times(st, net, dcfg["network"])
    n_lines = np.array([max(1, len(s["lines"])) for s in st])
    tram_only = np.array([all(net["lines"][li]["railType"] == 21 for li in s["lines"]) for s in st])
    print(f"ゾーン {len(pop):,} / 駅 {len(st):,} / ゾーン-駅ペア {len(pz):,}")
    return Inputs(pop, emp, dist_core, pz, ps, pdist, times, st, n_lines, tram_only)


def travel_times(st: list, net: dict, ncfg: dict) -> np.ndarray:
    """駅間の最短所要時間 [分]。

    ノード: 駅 S、（駅, 事業者）、（駅, 路線）。乗換抵抗は
      同一事業者の路線間 = τ_same（(駅,路線)↔(駅,事業者) を τ_same/2 ずつ）
      他事業者間 = τ_other（さらに (駅,事業者)↔S を (τ_other−τ_same)/2 ずつ）
    で表す。駅 S から乗って駅 S で降りると両端で τ_other が加わるので最後に差し引く。
    """
    lines = net["lines"]
    t_same = ncfg["transfer_same_operator_min"]
    t_other = ncfg["transfer_other_operator_min"]
    n = len(st)
    ids: dict[tuple, int] = {}

    def node(key: tuple) -> int:
        if key not in ids:
            ids[key] = n + len(ids)
        return ids[key]

    rows, cols, w = [], [], []

    def edge(a: int, b: int, cost: float) -> None:
        rows.append(a)
        cols.append(b)
        w.append(max(cost, 1e-6))

    for si, s in enumerate(st):
        for li in s["lines"]:
            op = lines[li]["operator"]
            edge(node(("L", si, li)), node(("O", si, op)), t_same / 2)
        for op in {lines[li]["operator"] for li in s["lines"]}:
            edge(node(("O", si, op)), si, (t_other - t_same) / 2)
    for a, b, li, length_m in net["edges"]:
        minutes = length_m / 1000 / lines[li]["speedKmh"] * 60
        edge(node(("L", a, li)), node(("L", b, li)), minutes)
    for a, b, d_m in net["walk"]:
        edge(a, b, d_m * ncfg["walk_detour_factor"] / 1000 / ncfg["walk_speed_kmh"] * 60)

    size = n + len(ids)
    g = coo_matrix((w, (rows, cols)), shape=(size, size)).tocsr()
    t0 = time.time()
    dist = dijkstra(g, directed=False, indices=np.arange(n))[:, :n]
    times = np.maximum(dist - t_other, 0)
    np.fill_diagonal(times, 0)
    # ブラウザへは整数分（uint8）で渡すので、校正も同じ丸めた値で行う。255 分以上は到達不能扱い
    times = np.round(times)
    times[times >= 255] = np.inf
    reach = np.isfinite(times).mean()
    print(f"所要時間行列 {n}×{n}（{time.time() - t0:.1f}s）、到達可能な組 {reach:.1%}")
    return times


# ---------------------------------------------------------------------------
# モデル
# ---------------------------------------------------------------------------

PARAM_NAMES = ["accessDecayPerKm", "attractivenessExponent", "outsideConst", "outsidePerKm", "employeeWeight", "timeDecayPerMin"]


def unpack(u: np.ndarray) -> dict:
    return {k: float(v) for k, v in zip(PARAM_NAMES, u)}


def pack(p: dict) -> np.ndarray:
    return np.array([p[k] for k in PARAM_NAMES])


# 推定の範囲。制約なしの最適解は α≈25（魅力度による勝者総取り）、a₁<0（郊外ほど鉄道を使う）、
# γ≈0.009（所要時間がほぼ効かない）という非現実的な解になり、新駅を置いたときの挙動が極端に
# なるため、行動として妥当な範囲に制限する（docs/calibration.md §4 に制約なしの結果も記載）
BOUNDS = {
    "accessDecayPerKm": (0.5, 3.0),
    "attractivenessExponent": (0.0, 2.0),
    "outsideConst": (-6.0, 6.0),
    "outsidePerKm": (0.0, 0.2),
    "employeeWeight": (0.1, 3.0),
    "timeDecayPerMin": (0.02, 0.15),
}
UNBOUNDED = {k: (None, None) for k in PARAM_NAMES} | {
    "accessDecayPerKm": (0.05, None), "employeeWeight": (0.01, None), "timeDecayPerMin": (0.001, None)}


@dataclass
class Terms:
    mass: np.ndarray
    acc: np.ndarray
    catch_pop: np.ndarray
    catch_emp: np.ndarray
    rail_share: np.ndarray  # ゾーン別の鉄道利用確率 Σπ


def model_terms(inp: Inputs, p: dict, psi: float) -> Terms:
    nz, ns = len(inp.pop), len(inp.stations)
    f = np.exp(-p["accessDecayPerKm"] * inp.pair_d)
    # 集中量 M: 魅力度を使わない幾何的な按分（循環を避ける）
    geo_denom = np.bincount(inp.pair_z, weights=f, minlength=nz)
    w = f / geo_denom[inp.pair_z]
    mass = np.bincount(inp.pair_s, weights=w * (inp.emp[inp.pair_z] + psi * inp.pop[inp.pair_z]), minlength=ns)
    # ACC_s = Σ_{m≠s} M_m exp(−γ t_sm)
    decay = np.exp(-p["timeDecayPerMin"] * inp.times)
    np.fill_diagonal(decay, 0)
    acc = decay @ mass
    # 外部選択肢付き Huff
    attract = np.power(np.maximum(acc, 1.0) / ACC_REF, p["attractivenessExponent"])
    num = attract[inp.pair_s] * f
    outside = np.exp(p["outsideConst"] + p["outsidePerKm"] * inp.dist_core)
    denom = outside + np.bincount(inp.pair_z, weights=num, minlength=nz)
    pi = num / denom[inp.pair_z]
    catch_pop = np.bincount(inp.pair_s, weights=pi * inp.pop[inp.pair_z], minlength=ns)
    catch_emp = np.bincount(inp.pair_s, weights=pi * inp.emp[inp.pair_z], minlength=ns)
    rail_share = np.bincount(inp.pair_z, weights=pi, minlength=nz)
    return Terms(mass, acc, catch_pop, catch_emp, rail_share)


@dataclass
class Obs:
    """校正に使う観測（乗降集計クラスタ単位）"""
    idx: list[list[int]]  # クラスタを構成する駅の添字
    y: np.ndarray
    names: list[str]
    n_lines: np.ndarray
    cv_group: np.ndarray


def build_obs(inp: Inputs, year: int, dcfg: dict, excluded: list | None = None) -> Obs:
    st = inp.stations
    by_cluster: dict[str, list[int]] = {}
    for i, s in enumerate(st):
        by_cluster.setdefault(s["cluster"], []).append(i)
    id_to_idx = {s["id"]: i for i, s in enumerate(st)}
    skip = set(dcfg["calibration"]["exclude_station_names"])
    idx, y, names, nl, grp = [], [], [], [], []
    for cid, members in by_cluster.items():
        rep = st[id_to_idx[cid]]
        reason = None
        v = rep["ridership"].get(str(year))
        if not rep["inRegion"]:
            reason = "外周バッファ内"
        elif v is None or v <= 0:
            reason = "観測値なし"
        elif rep["partial"]:
            reason = "一部事業者のデータなし"
        elif rep["includesShinkansen"]:
            reason = "新幹線の利用者を含む"
        elif rep["name"] in skip:
            reason = "空港アクセス駅"
        elif all(inp.tram_only[m] for m in members):
            # 新線（普通鉄道）の推計に使うモデルなので、停留所間隔・需要構造の異なる路面電車は除く
            reason = "路面電車の停留所"
        if reason:
            if excluded is not None:
                excluded.append((rep["name"], reason))
            continue
        idx.append(members)
        y.append(float(v))
        names.append(rep["name"])
        nl.append(len({li for m in members for li in st[m]["lines"]}))
        # 空間交差検証のグループ: 2次メッシュ（約10km四方）
        lat, lng = rep["lat"], rep["lng"]
        grp.append(f"{int(lat * 1.5)}{int(lng) - 100:02d}{int((lat * 1.5 % 1) * 8)}{int((lng % 1) * 8)}")
    return Obs(idx, np.array(y), names, np.array(nl, float), np.array(grp))


def design(terms: Terms, obs: Obs, rho: float, with_hub: bool = True) -> np.ndarray:
    catch = np.array([sum(terms.catch_pop[m] + rho * terms.catch_emp[m] for m in g) for g in obs.idx])
    acc = np.array([max(terms.acc[m] for m in g) for g in obs.idx])
    cols = [np.ones(len(obs.y)), np.log(np.maximum(catch, 1.0)), np.log(np.maximum(acc, 1.0) / ACC_REF)]
    if with_hub:
        cols.append(np.log(obs.n_lines))
    return np.column_stack(cols)


def fit_glm(y: np.ndarray, x: np.ndarray, robust: bool = False):
    model = sm.GLM(y, x, family=sm.families.Poisson())
    return model.fit(cov_type="HC1") if robust else model.fit()


# ---------------------------------------------------------------------------
# 指標
# ---------------------------------------------------------------------------

def metrics(y: np.ndarray, yhat: np.ndarray) -> dict:
    ly, lh = np.log(y), np.log(yhat)
    ratio = np.abs(lh - ly)
    dev = 2 * np.sum(y * np.log(y / yhat) - (y - yhat))
    dev0 = 2 * np.sum(y * np.log(y / y.mean()) - (y - y.mean()))
    return {
        "n": int(len(y)),
        "pseudoR2": float(1 - dev / dev0),
        "logR2": float(np.corrcoef(ly, lh)[0, 1] ** 2),
        "rmse": float(np.sqrt(np.mean((y - yhat) ** 2))),
        "medianRatio": float(np.exp(np.median(ratio))),
        "within2x": float(np.mean(ratio <= np.log(2))),
        "totalRatio": float(yhat.sum() / y.sum()),
    }


def spatial_cv(y: np.ndarray, x: np.ndarray, groups: np.ndarray, k: int, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    uniq = np.unique(groups)
    fold_of = dict(zip(uniq, rng.integers(0, k, len(uniq))))
    folds = np.array([fold_of[g] for g in groups])
    pred = np.empty_like(y)
    for f in range(k):
        tr, te = folds != f, folds == f
        res = fit_glm(y[tr], x[tr])
        pred[te] = np.exp(x[te] @ res.params)
    return metrics(y, pred)


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------

def main() -> None:
    t_start = time.time()
    dcfg = load_demand_config()
    ccfg = dcfg["calibration"]
    psi = dcfg["mass"]["population_weight"]
    inp = load_inputs(dcfg)

    excluded: list = []
    obs = build_obs(inp, ccfg["year"], dcfg, excluded)
    print(f"{ccfg['year']}年度 校正対象 {len(obs.y):,} 駅（除外 {len(excluded)}）")

    evals = {"n": 0, "best": np.inf}

    def objective(u: np.ndarray) -> float:
        p = unpack(u)
        terms = model_terms(inp, p, psi)
        x = design(terms, obs, p["employeeWeight"])
        try:
            dev = fit_glm(obs.y, x).deviance
        except Exception:  # noqa: BLE001 — 発散したパラメータは大きな値で返す
            return 1e30
        evals["n"] += 1
        if dev < evals["best"]:
            evals["best"] = dev
        if evals["n"] % 50 == 0:
            print(f"  評価 {evals['n']}: 最良逸脱度 {evals['best']:,.0f} / 現在 {p}", flush=True)
        return dev

    start = {"accessDecayPerKm": 1.0, "attractivenessExponent": 0.5, "outsideConst": 0.0,
             "outsidePerKm": 0.05, "employeeWeight": 0.5, "timeDecayPerMin": 0.05}

    def optimize(bounds: dict):
        evals["n"], evals["best"] = 0, np.inf
        t0 = time.time()
        r = minimize(objective, pack(start), method="Nelder-Mead", bounds=[bounds[k] for k in PARAM_NAMES],
                     options={"maxiter": 2000, "xatol": 1e-4, "fatol": 1.0, "adaptive": True})
        print(f"最適化 {time.time() - t0:.0f}s / 評価 {evals['n']} 回 / 収束 {r.success}: {r.message}")
        return r, evals["n"]

    print("制約なしの推定（参考）")
    res_free, _ = optimize(UNBOUNDED)
    p_free = unpack(res_free.x)
    terms_free = model_terms(inp, p_free, psi)
    m_free = metrics(obs.y, fit_glm(obs.y, design(terms_free, obs, p_free["employeeWeight"])).fittedvalues)
    print("制約付きの推定（採用）")
    res, n_eval = optimize(BOUNDS)
    p = unpack(res.x)
    at_bound = [k for k in PARAM_NAMES
                if abs(p[k] - BOUNDS[k][0]) < 1e-3 * max(1, abs(BOUNDS[k][0])) or abs(p[k] - BOUNDS[k][1]) < 1e-3 * max(1, abs(BOUNDS[k][1]))]
    print("採用値:", p, "範囲の端:", at_bound)

    terms = model_terms(inp, p, psi)
    x = design(terms, obs, p["employeeWeight"])
    glm = fit_glm(obs.y, x, robust=True)
    coef = dict(zip(["intercept", "catchmentElasticity", "accessibilityElasticity", "hubElasticity"], glm.params))
    se = dict(zip(coef, glm.bse))
    yhat = glm.fittedvalues
    m_all = metrics(obs.y, yhat)
    m_cv = spatial_cv(obs.y, x, obs.cv_group, ccfg["cv_folds"], ccfg["random_seed"])
    print("当てはまり:", m_all)
    print("空間CV:", m_cv)

    # 感度分析: (a) 大ターミナル除外、(b) 比較年度（非線形パラメータは固定して線形部分のみ再推定）
    hub = obs.n_lines < ccfg["hub_lines_threshold"]
    glm_nohub = fit_glm(obs.y[hub], x[hub], robust=True)
    m_nohub = metrics(obs.y[hub], glm_nohub.fittedvalues)
    obs_cmp = build_obs(inp, ccfg["compare_year"], dcfg)
    x_cmp = design(terms, obs_cmp, p["employeeWeight"])
    glm_cmp = fit_glm(obs_cmp.y, x_cmp, robust=True)
    m_cmp = metrics(obs_cmp.y, glm_cmp.fittedvalues)

    # 駅勢圏由来の乗降（路線数の項を基準値 1 路線に固定）: 新線の駅・接続駅の推計に使う値
    lin = coef["intercept"] + coef["catchmentElasticity"] * np.log(np.maximum(terms.catch_pop + p["employeeWeight"] * terms.catch_emp, 1.0)) \
        + coef["accessibilityElasticity"] * np.log(np.maximum(terms.acc, 1.0) / ACC_REF)
    mu_catch = np.exp(lin)

    # 暗黙の原単位: 対象地域の人口あたりの駅勢圏由来乗降（往復の両端を数える）
    in_region = np.array([s["inRegion"] for s in inp.stations], bool)
    implied_ends_per_person = float(mu_catch[in_region].sum() / inp.pop.sum())
    zone_share = terms.rail_share

    # --- 出力 -----------------------------------------------------------
    fixed = {
        "access": {"detourFactor": dcfg["access"]["detour_factor"], "maxAccessKm": dcfg["access"]["max_access_km"]},
        "mass": {"populationWeight": psi},
        "network": {
            "transferSameOperatorMin": dcfg["network"]["transfer_same_operator_min"],
            "transferOtherOperatorMin": dcfg["network"]["transfer_other_operator_min"],
            "walkSpeedKmh": dcfg["network"]["walk_speed_kmh"],
            "walkDetourFactor": dcfg["network"]["walk_detour_factor"],
        },
        "service": {"scheduledSpeedKmh": dcfg["service"]["scheduled_speed_kmh"]},
        "shortcut": {"neighborhoodMin": dcfg["shortcut"]["neighborhood_min"], "routeLogitPerMin": dcfg["shortcut"]["route_logit_per_min"]},
    }
    out = {
        "version": 1,
        "calibratedAt": dt.date.today().isoformat(),
        "year": ccfg["year"],
        "accRef": ACC_REF,
        **fixed,
        "fitted": {**p, **{k: float(v) for k, v in coef.items()}},
        "metrics": m_all,
    }
    cfg_path = ROOT / "src" / "config" / "demand.calibrated.json"
    cfg_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    stations_path = PUBLIC_DATA / "stations.json"
    sdata = json.loads(stations_path.read_text(encoding="utf-8"))
    catch = terms.catch_pop + p["employeeWeight"] * terms.catch_emp
    for i, s in enumerate(sdata["stations"]):
        s["acc"] = round(float(terms.acc[i]))
        s["mass"] = round(float(terms.mass[i]))
        s["catch"] = round(float(catch[i]), 1)
        s["muCatch"] = round(float(mu_catch[i]))
    sdata["note"] = sdata["note"].split("accessibility は")[0].split("acc/mass")[0] + "acc/mass/catch/muCatch は calibrate.py の出力。"
    stations_path.write_text(json.dumps(sdata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 駅間所要時間: 上三角（i<j）を行優先で uint8（分）。255 = 到達不能
    iu = np.triu_indices(len(inp.stations), 1)
    tri = inp.times[iu]
    packed = np.where(np.isfinite(tri), np.minimum(tri, 254), 255).astype(np.uint8)
    (PUBLIC_DATA / "times.bin").write_bytes(packed.tobytes())
    print(f"times.bin: {packed.nbytes / 1024 / 1024:.2f} MB")

    table = pd.DataFrame({
        "name": obs.names, "lines": obs.n_lines.astype(int), "observed": obs.y.round(),
        "predicted": np.round(yhat), "ratio": yhat / obs.y,
        "catchment": [sum(terms.catch_pop[m] + p["employeeWeight"] * terms.catch_emp[m] for m in g) for g in obs.idx],
        "acc": [max(terms.acc[m] for m in g) for g in obs.idx],
    })
    INTERIM.mkdir(parents=True, exist_ok=True)
    table.to_csv(INTERIM / "calibration_stations.csv", index=False, encoding="utf-8")

    write_report(p, coef, se, m_all, m_cv, m_nohub, int(hub.sum()), glm_nohub, m_cmp, glm_cmp, ccfg, table,
                 excluded, implied_ends_per_person, inp, zone_share, res, n_eval, dcfg, p_free, m_free, at_bound)
    print(f"完了（{time.time() - t_start:.0f}s）")


def write_report(p, coef, se, m_all, m_cv, m_nohub, n_nohub, glm_nohub, m_cmp, glm_cmp, ccfg, table, excluded,
                 implied, inp, zone_share, opt, n_eval, dcfg, p_free, m_free, at_bound) -> None:
    f = lambda x, d=3: f"{x:.{d}f}"
    lines = []
    w = lines.append
    w("# 校正結果（需要モデル）")
    w("")
    w(f"生成: `scripts/calibrate.py`（{dt.date.today().isoformat()}）。手法は docs/design.md §4・§5。数値はこのファイルを再生成すると更新される。")
    w("")
    w("## 1. 概要")
    w("")
    w(f"- 目的変数: S12 駅別乗降客数（{ccfg['year']}年度、1日あたり）。乗降集計クラスタ単位で {m_all['n']:,} 駅。")
    w(f"- 手法: ポアソン疑似最尤法（PPML、頑健標準誤差 HC1）＋非線形パラメータの外側最適化（Nelder–Mead、評価 {n_eval} 回、収束: {opt.success}）。")
    w("- PPML を選んだ理由: 対数 OLS は誤差分散が平均に依存すると水準の予測が偏る（再変換バイアス）。収入は水準で効くため、"
      "平均の関数形さえ正しければ一致推定になる PPML を採用（Santos Silva & Tenreyro, 2006）。数百〜数百万人の幅にも対応できる。")
    w("")
    w("| 指標 | 全駅（学習） | 空間交差検証（5分割） |")
    w("|---|---|---|")
    w(f"| 疑似 R²（逸脱度） | {f(m_all['pseudoR2'])} | {f(m_cv['pseudoR2'])} |")
    w(f"| 対数スケールの R² | {f(m_all['logR2'])} | {f(m_cv['logR2'])} |")
    w(f"| RMSE（人/日） | {m_all['rmse']:,.0f} | {m_cv['rmse']:,.0f} |")
    w(f"| 誤差倍率の中央値 | {f(m_all['medianRatio'], 2)} 倍 | {f(m_cv['medianRatio'], 2)} 倍 |")
    w(f"| 2倍以内に収まる駅の割合 | {m_all['within2x']:.0%} | {m_cv['within2x']:.0%} |")
    w(f"| 推計合計 / 観測合計 | {f(m_all['totalRatio'])} | {f(m_cv['totalRatio'])} |")
    w("")
    w("空間交差検証は 2次メッシュ（約10km四方）単位で駅を 5 群に分け、線形部分のみ再推定して未使用の群を予測した（非線形パラメータは全駅推定値で固定）。")
    w("")
    w("## 2. 推定パラメータ")
    w("")
    w("### 非線形パラメータ（駅勢圏・アクセシビリティ）")
    w("")
    w("推定範囲を制約している（§4 参照）。" + (f"範囲の端に張り付いたパラメータ: {', '.join(at_bound)}。" if at_bound else "どのパラメータも範囲の端には張り付いていない。"))
    w("")
    w("| パラメータ | 記号 | 推定値 | 推定範囲 | 解釈 |")
    w("|---|---|---|---|---|")
    rng = lambda k: f"{BOUNDS[k][0]}〜{BOUNDS[k][1]}"
    b = p["accessDecayPerKm"]
    w(f"| 駅までの距離減衰 | β | {f(b)} /km | {rng("accessDecayPerKm")} | 1km 先の駅の重みは {np.exp(-b):.2f} 倍 |")
    w(f"| 駅の魅力度指数 | α | {f(p['attractivenessExponent'])} | {rng("attractivenessExponent")} | 魅力度 A = (ACC/10⁶)^α |")
    w(f"| 外部選択肢（鉄道を使わない）定数 | a₀ | {f(p['outsideConst'])} | {rng("outsideConst")} | |")
    w(f"| 外部選択肢の都心距離係数 | a₁ | {f(p['outsidePerKm'], 4)} /km | {rng("outsidePerKm")} | 都心から 30km で外部選択肢の重みが {np.exp(p['outsidePerKm'] * 30):.2f} 倍 |")
    w(f"| 従業者 1 人の重み（人口比） | ρ | {f(p['employeeWeight'])} | {rng("employeeWeight")} | |")
    g = p["timeDecayPerMin"]
    w(f"| 所要時間の減衰 | γ | {f(g, 4)} /分 | {rng("timeDecayPerMin")} | 30 分先の目的地の重みは {np.exp(-g * 30):.2f} 倍 |")
    w("")
    w("### 線形パラメータ（PPML）")
    w("")
    w("ln μ = c₀ + η·ln(駅勢圏人口 + ρ·駅勢圏従業者) + θ·ln(ACC/10⁶) + κ·ln(路線数)")
    w("")
    w("| 係数 | 推定値 | 頑健標準誤差 |")
    w("|---|---|---|")
    labels = {"intercept": "c₀ 切片", "catchmentElasticity": "η 駅勢圏の弾力性", "accessibilityElasticity": "θ ACC の弾力性", "hubElasticity": "κ 路線数の弾力性（校正時のみ）"}
    for k, v in coef.items():
        w(f"| {labels[k]} | {f(v)} | {f(se[k])} |")
    w("")
    w("κ（路線数）は S12 が乗換客を含んで数えることを吸収するための項で、新線の推計では使わない（乗換は分布段階で明示的に計算する）。")
    w("")
    w("## 3. 妥当性の確認")
    w("")
    w(f"- 駅勢圏由来の乗降（κ の項を除いた推計）の合計は対象地域人口 1 人あたり **{implied:.2f}** 回/日。"
      "東京都市圏PT調査の原単位（約 2.0〜2.4 トリップ/人日、鉄道分担率 約 3 割）から、鉄道トリップの両端を数えると "
      "おおむね 1.2〜1.5 回/人日程度と見込まれ、これと比較する（乗換による重複や来訪者も含むため完全には一致しない）。")
    share_in = zone_share[inp.pop > 0]
    near = inp.dist_core[inp.pop > 0]
    w("- ゾーンの鉄道利用確率 Σπ（外部選択肢を除いた駅の選択確率の合計）の人口加重平均（都心距離帯別）:")
    w("")
    w("| 都心距離 | Σπ |")
    w("|---|---|")
    pops = inp.pop[inp.pop > 0]
    for lo, hi in [(0, 10), (10, 20), (20, 30), (30, 50), (50, 120)]:
        msk = (near >= lo) & (near < hi)
        if msk.any():
            w(f"| {lo}〜{hi} km | {np.average(share_in[msk], weights=pops[msk]):.2f} |")
    w("")
    w("## 4. 感度分析")
    w("")
    w("### 制約なしの推定との比較")
    w("")
    w("非線形パラメータに範囲を設けずに推定すると当てはまりは良くなるが、パラメータが行動として不自然な値になる。")
    w("")
    w("| | β | α | a₀ | a₁ | ρ | γ | 疑似 R² | 対数 R² | 誤差倍率中央値 |")
    w("|---|---|---|---|---|---|---|---|---|---|")
    for label, pp, mm in [("制約付き（採用）", p, m_all), ("制約なし（参考）", p_free, m_free)]:
        w(f"| {label} | {f(pp['accessDecayPerKm'])} | {f(pp['attractivenessExponent'])} | {f(pp['outsideConst'])} | {f(pp['outsidePerKm'], 4)} | "
          f"{f(pp['employeeWeight'])} | {f(pp['timeDecayPerMin'], 4)} | {f(mm['pseudoR2'])} | {f(mm['logR2'])} | {f(mm['medianRatio'], 2)} |")
    w("")
    w("制約なしの解は α が非常に大きく（駅の魅力度の差がわずかでも利用者がほぼ全員一方の駅に集まる）、a₁ が負（都心から離れるほど鉄道を使う）、"
      "γ がほぼ 0（遠い目的地でも重みが下がらない）となる。駅勢圏の取り合いと所要時間の効果が駅単位の乗降データだけでは識別しきれないためと考えられる。"
      "このままでは新駅を少し動かしただけで需要が極端に変わるため、行動として妥当な範囲に制限して推定した（範囲は §2 の表）。"
      "OD データ（大都市交通センサス、PT 調査）が使えるようになれば、γ や α は分布・経路の観測から直接推定できる。")
    w("")
    w("### 線形部分の再推定")
    w("")
    w("非線形パラメータを固定し、線形部分のみ再推定した。")
    w("")
    w("| ケース | 駅数 | η | θ | κ | 疑似 R² | 対数 R² | 誤差倍率中央値 |")
    w("|---|---|---|---|---|---|---|---|")
    w(f"| 基本（{ccfg['year']}年度） | {m_all['n']} | {f(coef['catchmentElasticity'])} | {f(coef['accessibilityElasticity'])} | {f(coef['hubElasticity'])} | {f(m_all['pseudoR2'])} | {f(m_all['logR2'])} | {f(m_all['medianRatio'], 2)} |")
    pn = glm_nohub.params
    w(f"| 路線数 {ccfg['hub_lines_threshold']} 以上の大ターミナルを除外 | {n_nohub} | {f(pn[1])} | {f(pn[2])} | {f(pn[3])} | {f(m_nohub['pseudoR2'])} | {f(m_nohub['logR2'])} | {f(m_nohub['medianRatio'], 2)} |")
    pc = glm_cmp.params
    w(f"| {ccfg['compare_year']}年度（コロナ前） | {m_cmp['n']} | {f(pc[1])} | {f(pc[2])} | {f(pc[3])} | {f(m_cmp['pseudoR2'])} | {f(m_cmp['logR2'])} | {f(m_cmp['medianRatio'], 2)} |")
    w("")
    w("## 5. 残差の大きい駅")
    w("")
    t = table.assign(abs_log=np.abs(np.log(table["ratio"])))
    for title, sub in [("過大推計（推計 > 観測）", t[t["ratio"] > 1].nlargest(15, "abs_log")),
                       ("過小推計（推計 < 観測）", t[t["ratio"] < 1].nlargest(15, "abs_log"))]:
        w(f"### {title}")
        w("")
        w("| 駅 | 路線数 | 観測 | 推計 | 推計/観測 |")
        w("|---|---|---|---|---|")
        for _, r in sub.iterrows():
            w(f"| {r['name']} | {r['lines']} | {r['observed']:,.0f} | {r['predicted']:,.0f} | {r['ratio']:.2f} |")
        w("")
    w("考えられる原因（M4 時点の所見）: 観光・レジャー・大学・空港・競技場など駅勢圏の人口・従業者で説明できない需要、"
      "乗換客の計上方法の違い（事業者により乗換を含む・含まない）、N02 の法令上の線名による路線数の過小評価（例: 溝の口は田園都市線のみ、津田沼は総武線のみと数えられ、乗換の多さが κ の項に反映されない）、急行停車の有無（Phase 1 では考慮しない）、"
      "および表定速度の仮置きによる所要時間の誤差。")
    w("")
    w("## 6. 除外した駅")
    w("")
    reasons = pd.Series([r for _, r in excluded]).value_counts()
    w("| 理由 | 駅数 |")
    w("|---|---|")
    for r, n in reasons.items():
        w(f"| {r} | {n} |")
    w("")
    named = [f"{n}（{r}）" for n, r in excluded if r in ("新幹線の利用者を含む", "空港アクセス駅")]
    if named:
        w("新幹線・空港による除外: " + "、".join(named))
        w("")
    w("## 7. 固定パラメータ（校正していない値）")
    w("")
    w("`scripts/config/demand.yaml` で設定。いずれも**仮置き**。")
    w("")
    w(f"- 迂回係数 {dcfg['access']['detour_factor']}、駅勢圏の上限 {dcfg['access']['max_access_km']} km（道のり）")
    w(f"- 集中量に加える人口の重み ψ = {dcfg['mass']['population_weight']}")
    w(f"- 乗換抵抗: 同一事業者 {dcfg['network']['transfer_same_operator_min']} 分、他事業者・新線 {dcfg['network']['transfer_other_operator_min']} 分")
    w(f"- 既存線の表定速度: `scripts/config/pipeline.yaml` の `rail.speed_kmh`")
    w(f"- 新線の表定速度 {dcfg['service']['scheduled_speed_kmh']} km/h")
    w(f"- 短絡利用: 接続駅から {dcfg['shortcut']['neighborhood_min']} 分以内の駅を対象、経路選択ロジット {dcfg['shortcut']['route_logit_per_min']} /分")
    w("")
    (ROOT / "docs" / "calibration.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
