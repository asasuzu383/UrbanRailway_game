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
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
PUBLIC_DATA = ROOT / "public" / "data"
CONFIG_PATH = Path(__file__).resolve().parent / "config" / "pipeline.yaml"

# 平面計算用の投影座標系（JGD2011 / UTM zone 54N）。首都圏全域で歪みが小さい
CRS_METRIC = "EPSG:6691"
CRS_GEO = "EPSG:6668"  # JGD2011 地理座標


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


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
    with (Path(__file__).resolve().parent / "config" / "demand.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)
