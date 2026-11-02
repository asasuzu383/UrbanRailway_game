"""公共交通オープンデータセンター（ODPT）の時刻表データの取得（Phase 2 M1）。

- キー不要のダンプ（api-public.odpt.org。CC BY 4.0 等のデータ）は常に取得する。
- 公共交通オープンデータ基本ライセンスの事業者（scripts/config/services.yaml の odpt.operators で access: key）は、
  .env の ODPT_ACCESS_TOKEN があるときだけ取得する。トークンは開発者サイト（https://developer.odpt.org/）で
  ユーザ登録して発行を受ける。.env は git 管理外（.gitignore）。

取得したデータは data/raw/odpt/（git 管理外）に置く。基本ライセンスのデータは、元の時刻表を復元できる形では
公開できない（同ライセンス第8条4項）ので、06_services.py で種別ごとの駅間所要時間の中央値・時間あたり本数に集計した値だけを
public/data/services.json に書き出す。

    .venv\\Scripts\\python.exe scripts\\odpt_download.py
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import requests
import yaml

from common import RAW, ROOT, sha256_of

PUBLIC_BASE = "https://api-public.odpt.org/api/v4"
KEY_BASE = "https://api.odpt.org/api/v4"
TYPES = ["TrainTimetable", "Station", "Railway", "TrainType"]
OUT = RAW / "odpt"
USER_AGENT = "UrbanRailway_game-preprocess/0.2"


def load_env() -> None:
    """プロジェクト直下の .env（KEY=VALUE 形式）を環境変数に読み込む（既に設定されている値は上書きしない）。"""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def fetch(url: str, dest: Path, manifest: dict, label: str) -> None:
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=300, headers={"User-Agent": USER_AGENT}, allow_redirects=True)
            r.raise_for_status()
            json.loads(r.content)  # JSON であることの確認（エラーページの保存を防ぐ）
            dest.write_bytes(r.content)
            manifest[dest.name] = {"source": label, "bytes": dest.stat().st_size, "sha256": sha256_of(dest),
                                   "retrieved": dt.datetime.now().isoformat(timespec="seconds")}
            print(f"取得 {dest.name}: {dest.stat().st_size / 1e6:.1f} MB")
            return
        except Exception as e:  # noqa: BLE001 — リトライして最後に報告
            if attempt == 2:
                raise RuntimeError(f"{label}: {e}") from e
            time.sleep(3 * (attempt + 1))


def main() -> int:
    load_env()
    with (Path(__file__).resolve().parent / "config" / "services.yaml").open(encoding="utf-8") as f:
        ocfg = yaml.safe_load(f)["odpt"]
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    for t in TYPES:
        fetch(f"{PUBLIC_BASE}/odpt:{t}.json", OUT / f"public_{t}.json", manifest, f"api-public odpt:{t}.json")
        time.sleep(1)

    keyed = [k for k, v in ocfg["operators"].items() if v["access"] == "key"]
    token = os.environ.get("ODPT_ACCESS_TOKEN")
    if not token:
        print(f"ODPT_ACCESS_TOKEN が未設定のため、基本ライセンスの事業者（{', '.join(keyed)}）は取得しない。")
    else:
        for t in TYPES:
            for op in keyed:
                url = f"{KEY_BASE}/odpt:{t}?odpt:operator=odpt.Operator:{op}&acl:consumerKey={token}"
                # 1 回の API 呼び出しは最大 1000 件。超える場合は件数を報告する（ダンプ取得への切り替えが必要）
                fetch(url, OUT / f"key_{op}_{t}.json", manifest, f"api odpt:{t} operator={op}")
                n = len(json.loads((OUT / f"key_{op}_{t}.json").read_text(encoding="utf-8")))
                if n >= 1000:
                    print(f"  注意: {op} の {t} が 1000 件（上限）に達した。全件取得の方法を確認すること")
                time.sleep(1)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
