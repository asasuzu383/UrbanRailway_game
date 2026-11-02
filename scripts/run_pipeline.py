"""前処理パイプラインを番号順に実行する（M1）。

    .venv\\Scripts\\python.exe scripts\\run_pipeline.py            # 全段
    .venv\\Scripts\\python.exe scripts\\run_pipeline.py 02 03      # 指定した段だけ（校正は calibrate）
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ["00_download", "odpt_download", "01_region", "02_zones", "03_rail", "04_ridership", "05_landprice", "06_services", "calibrate"]


def main(argv: list[str]) -> int:
    env = dict(os.environ)
    if "--region" in argv:
        i = argv.index("--region")
        env["URBANRAIL_REGION"] = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    selected = [s for s in STEPS if not argv or s[:2] in argv or s in argv]
    print(f"対象地域: {env.get('URBANRAIL_REGION', 'shutoken')}")
    for step in selected:
        print(f"\n=== {step} ===", flush=True)
        r = subprocess.run([sys.executable, "-u", str(HERE / f"{step}.py")], cwd=HERE, env=env)
        if r.returncode != 0:
            print(f"{step} が失敗しました（終了コード {r.returncode}）")
            return r.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
