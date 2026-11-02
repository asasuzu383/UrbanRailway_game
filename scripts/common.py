"""前処理スクリプト共通のパス・設定・ユーティリティ。"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import yaml

# Windows コンソール（cp932）でも日本語ログが化けないようにする
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = Path(__file__).resolve().parent / "config"
CONFIG_PATH = CONFIG_DIR / "pipeline.yaml"
DEFAULT_REGION = "shutoken"


def _select_region() -> str:
    """対象地域: コマンドラインの --region <id>（または --region=<id>）、環境変数 URBANRAIL_REGION、既定 shutoken の順。
    --region は sys.argv から取り除く（各スクリプトの引数の解釈に影響させない）。"""
    region = None
    for i, a in enumerate(list(sys.argv)):
        if a == "--region" and i + 1 < len(sys.argv):
            region = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
        if a.startswith("--region="):
            region = a.split("=", 1)[1]
            del sys.argv[i]
            break
    import os
    return region or os.environ.get("URBANRAIL_REGION") or DEFAULT_REGION


REGION = _select_region()
REGION_DIR = CONFIG_DIR / "regions" / REGION
if not (REGION_DIR / "region.yaml").exists():
    raise SystemExit(f"地域 {REGION} の設定がありません: {REGION_DIR / 'region.yaml'}")
with (REGION_DIR / "region.yaml").open(encoding="utf-8") as _f:
    REGION_CONFIG: dict = yaml.safe_load(_f)

RAW = ROOT / "data" / "raw"  # 生データは全国共通（N02・S12 は全国版、メッシュ・県別ファイルは地域の設定に応じて取得）
INTERIM = ROOT / "data" / "interim" / REGION
PUBLIC_DATA = ROOT / "public" / "data" / REGION
CALIBRATED_PATH = ROOT / "src" / "config" / "regions" / REGION / "demand.calibrated.json"

# 平面計算用の投影座標系（地域の設定。首都圏は JGD2011 / UTM zone 54N）
CRS_METRIC = REGION_CONFIG["crs_metric"]
CRS_GEO = "EPSG:6668"  # JGD2011 地理座標


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config() -> dict:
    """全国共通の pipeline.yaml に地域の設定（対象地域・1次メッシュ・都府県・都心の基準点）を重ねたもの"""
    with CONFIG_PATH.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    r = REGION_CONFIG
    cfg["region_id"] = r["id"]
    cfg["region"] = r["region"]
    cfg["primary_meshes"] = r["primary_meshes"]
    cfg["core_point"] = r["core_point"]
    cfg["sources"]["N03_L01_prefectures"] = r["prefectures"]
    return cfg


def region_config_path(name: str) -> Path:
    """地域ごとの設定ファイル（services.yaml、backtest.yaml など）"""
    return REGION_DIR / name


def docs_path(name: str) -> Path:
    """生成するドキュメントの出力先。首都圏は docs/ 直下（既存の場所）、他の地域は docs/regions/<id>/"""
    return ROOT / "docs" / name if REGION == DEFAULT_REGION else ROOT / "docs" / "regions" / REGION / name


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def vsizip(zip_path: Path, inner: str) -> str:
    """ZIP 内のファイルを pyogrio で直接読むためのパス。"""
    return f"/vsizip/{zip_path.as_posix()}/{inner}"


def ksj_zip(cfg: dict, key: str, pref: str | None = None) -> Path:
    s = cfg["sources"][key]
    fname = s["file"] if pref is None else s["file_pattern"].format(pref=pref)
    return RAW / "ksj" / key / fname


def write_json(path: Path, obj: object, *, compact: bool = True) -> int:
    """JSON を書き出してバイト数を返す。compact=True なら区切りの空白を省く。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                      indent=None if compact else 2)
    path.write_text(text, encoding="utf-8")
    return path.stat().st_size


def half_mesh_centroid(codes) -> tuple:
    """2分の1地域メッシュコード（9桁、文字列または整数の配列）の中心経度・緯度。src/data/meshCode.ts と同じ定義。"""
    import numpy as np

    c = np.asarray(codes, dtype=np.int64)
    s = c % 10 - 1
    w = c // 10 % 10
    r = c // 100 % 10
    v = c // 1000 % 10
    q = c // 10000 % 10
    u = c // 100000 % 100
    p = c // 10000000
    dlat3, dlng3 = (2 / 3) / 80, 1 / 80
    south = p / 1.5 + q * (2 / 3) / 8 + r * dlat3 + (s // 2) * dlat3 / 2
    west = u + 100 + v / 8 + w * dlng3 + (s % 2) * dlng3 / 2
    return west + dlng3 / 4, south + dlat3 / 4


def load_demand_config() -> dict:
    """需要モデルの固定パラメータ: 全国共通の demand.yaml に地域の設定（region.yaml の demand）を重ねたもの"""
    with (CONFIG_DIR / "demand.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return _deep_merge(cfg, REGION_CONFIG.get("demand", {}))
