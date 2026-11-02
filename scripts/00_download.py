"""生データのダウンロード。

既にファイルがあればスキップする（再実行可能）。取得結果は data/raw/manifest.json に
ファイル名・サイズ・SHA-256・取得日時として記録する。

    .venv\\Scripts\\python.exe scripts\\00_download.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import time
import zipfile
from pathlib import Path

import requests

from common import RAW, load_config, sha256_of

USER_AGENT = "UrbanRailway_game-preprocess/0.1 (+https://github.com/)"


def plan_downloads(cfg: dict) -> list[tuple[str, Path]]:
    s = cfg["sources"]
    base = s["ksj_base"]
    jobs: list[tuple[str, Path]] = []

    for key in ("N02", "S12"):
        ver, fname = s[key]["version"], s[key]["file"]
        jobs.append((f"{base}/{key}/{ver}/{fname}", RAW / "ksj" / key / fname))

    for key in ("N03", "L01"):
        ver = s[key]["version"]
        for pref in s["N03_L01_prefectures"]:
            fname = s[key]["file_pattern"].format(pref=pref)
            jobs.append((f"{base}/{key}/{ver}/{fname}", RAW / "ksj" / key / fname))

    for sub, stats_id in (("census2020", s["census"]["stats_id"]), ("econ2021", s["econ_census"]["stats_id"]),
                          ("census2000", s["census2000"]["stats_id"])):
        for mesh in cfg["primary_meshes"]:
            url = s["estat_url"].format(stats_id=stats_id, mesh=mesh)
            jobs.append((url, RAW / "estat" / sub / f"{stats_id}_{mesh}.zip"))
    return jobs


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=120, headers={"User-Agent": USER_AGENT}) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            if not zipfile.is_zipfile(tmp):
                raise ValueError("ZIP ではないレスポンス（エラーページの可能性）")
            tmp.replace(dest)
            return
        except Exception as e:  # noqa: BLE001 — リトライして最後に再送出
            if attempt == 2:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"{url}: {e}") from e
            time.sleep(3 * (attempt + 1))


def main() -> int:
    cfg = load_config()
    manifest_path = RAW / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    failed: list[tuple[str, Path, str]] = []

    for url, dest in plan_downloads(cfg):
        rel = dest.relative_to(RAW).as_posix()
        if dest.exists() and rel in manifest:
            continue
        print(f"DL {rel}", flush=True)
        try:
            download(url, dest)
        except RuntimeError as e:
            failed.append((url, dest, str(e)))
            continue
        manifest[rel] = {
            "url": url,
            "bytes": dest.stat().st_size,
            "sha256": sha256_of(dest),
            "retrieved": dt.datetime.now().isoformat(timespec="seconds"),
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(0.5)  # 配信元への負荷を抑える

    if failed:
        print("\n自動ダウンロードできなかったファイル（手動で取得して配置してください）:")
        for url, dest, err in failed:
            print(f"- {dest.relative_to(RAW.parent.parent)}\n    URL: {url}\n    エラー: {err}")
        return 1
    print(f"完了: {len(manifest)} ファイル")
    return 0


if __name__ == "__main__":
    sys.exit(main())
