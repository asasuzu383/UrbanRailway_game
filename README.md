# 首都圏 鉄道新線計画シミュレーター

首都圏の実際の地図の上に鉄道の新線を描くと、乗客数・営業収支・建設費の回収年数を推計するブラウザゲームです。

- 対象地域: 東京都（島しょ部を除く）・神奈川県・埼玉県・千葉県・茨城県南部
- 公開ページ: https://asasuzu383.github.io/UrbanRailway_game/ （GitHub Pages）

## 遊び方

1. 「路線」タブで「駅を置く」を選び、地図をクリックして駅を並べます。既存駅の近くに置くと乗換駅になります。
2. 駅と駅の間の区間ごとに、構造（地平・高架・地下）を選びます。路線の上をクリックすると駅や中間点（カーブ）を挿入でき、ドラッグで移動、右クリックまたは Delete キーで削除できます。
3. 「結果」タブで、黒字か赤字か、建設費の回収年数、累積キャッシュフローのグラフ、建設費・経費の内訳、駅ごとの乗降人員を確認します。
4. 「パラメータ」タブで運賃・建設単価・運行本数・割引率などを変えると、すぐに計算し直します。
5. 描いた路線はブラウザに自動保存されます。JSON ファイルへの書き出し・読み込みもできます。

Ctrl+Z / Ctrl+Y で元に戻す・やり直し、Esc で選択に戻ります。

## 推計のしくみ（概要）

詳しくは [docs/design.md](docs/design.md)。

- **需要**: 500m メッシュの人口・従業者数から、各メッシュの人が新線の駅を使う確率（駅までの距離と駅の魅力度による駅選択モデル）を求め、駅ごとの発生量を推計します。
  駅間の流動は既存鉄道の全駅間の所要時間を使った重力モデルで配分し、既存線から新線経由への経路転換も含めます。
  モデルの係数は既存 1,421 駅の 2024 年度の乗降客数で校正しています（決定係数 約0.83、結果は [docs/calibration.md](docs/calibration.md)）。
- **建設費**: 構造別の km 単価と駅単価、用地費（地価公示の住宅地価格）、車両費。
- **収支**: 運賃収入 − 運行経費（車両キロ・線路保守・駅運営・管理費）。単価は国土交通省の「基準単価・基準コスト算定データ」などから設定し、出典は [src/config/cost.ts](src/config/cost.ts) に書いています。
- **回収年数**: 減価償却前の営業収支で建設費を回収する年数（単純・割引率 4%）。

### 注意

推計は簡略化したモデルによる目安で、実際の事業計画の評価には使えません。主な限界は次のとおりです。

- 急行・直通運転・混雑を考慮していません。既存線の所要時間は表定速度の仮置き値から計算しています。
- 新線は 1 路線のみ、運行本数は固定です（本数と需要の相互作用はありません）。
- 地平・高架の建設単価、用地幅、運行本数、需要の立ち上がりなどは根拠の弱い「仮置き」の値です。
- 減価償却費・諸税・建設期間中の利子・更新投資・既存線の収支への影響は含みません。

## 開発

必要なもの: Node.js 24（20.19 以上で動作）、データを作り直す場合は Python 3.14。

```powershell
npm ci             # 依存パッケージのインストール
npm run dev        # 開発サーバ（http://localhost:5173/）
npm test           # 単体テスト（vitest）
npm run typecheck  # 型チェック
npm run build      # 本番ビルド（dist/）
```

ブラウザが読む加工済みデータ（`public/data/`、約 3MB）はリポジトリに含まれているので、アプリを動かすだけなら Python は不要です。

### データの作り直し

元データは `scripts/00_download.py` が自動でダウンロードします（`data/raw/`、git 管理外）。

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts\requirements.txt
.\.venv\Scripts\python.exe scripts\run_pipeline.py   # ダウンロード・前処理・校正を順に実行
```

### ディレクトリ

| パス | 内容 |
|---|---|
| `src/core/` | ドメイン型と幾何ユーティリティ |
| `src/data/` | 加工済みデータの読み込み |
| `src/network/` | 路線モデル（編集操作）と線形の計算 |
| `src/demand/` | 需要推計エンジン |
| `src/finance/` | 建設費・収入・経費・回収年数 |
| `src/config/` | パラメータ（出典つき） |
| `src/state/`, `src/ui/` | アプリの状態と画面 |
| `scripts/` | Python の前処理・校正 |
| `docs/` | 設計・データ出典・校正結果 |
| `tests/` | vitest |

### 公開（GitHub Pages）

`main` ブランチに push すると、GitHub Actions（[.github/workflows/deploy.yml](.github/workflows/deploy.yml)）がテスト・ビルドして GitHub Pages に公開します。
ビルド時の `base` はリポジトリ名から自動で決まります（`BASE_PATH=/<リポジトリ名>/`）。

初回だけ、リポジトリの **Settings → Pages → Build and deployment → Source** を「GitHub Actions」にしてください。

手元でサブパス配信を確認するには（PowerShell）:

```powershell
$env:BASE_PATH='/UrbanRailway_game/'; npm run build; Remove-Item Env:BASE_PATH
npx vite preview --base /UrbanRailway_game/   # http://localhost:4173/UrbanRailway_game/
```

## 出典

本アプリは次のデータを加工して作成しています。版・URL・利用条件の詳細は [docs/data-sources.md](docs/data-sources.md) を参照してください。

- 背景地図: 国土地理院「[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（淡色地図）」
- 人口: 総務省統計局「令和2年国勢調査 地域メッシュ統計」（[e-Stat](https://www.e-stat.go.jp/gis/statmap-search?type=1)）を加工して作成
- 従業者数: 総務省統計局「令和3年経済センサス‐活動調査 地域メッシュ統計」（[e-Stat](https://www.e-stat.go.jp/gis/statmap-search?type=1)）を加工して作成
- 鉄道路線・駅: 「[国土数値情報（鉄道データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html)」（国土交通省）を加工して作成
- 駅別乗降客数: 「[国土数値情報（駅別乗降客数データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-S12-2024.html)」（国土交通省）を加工して作成
- 行政区域: 「[国土数値情報（行政区域データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html)」（国土交通省）を加工して作成
- 地価: 「[国土数値情報（地価公示データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-L01-2026.html)」（国土交通省）を加工して作成
- 費用・運賃の単価: 国土交通省「[基準単価・基準コスト算定データ](https://www.mlit.go.jp/tetudo/content/001977442.pdf)」ほか（[src/config/cost.ts](src/config/cost.ts) に一覧）

本アプリの推計値は上記データをもとに独自のモデルで算出したものであり、各提供機関および鉄道事業者の見解ではありません。

## 免責事項

本アプリの推計は簡略化したモデルによる目安であり、正確性・完全性を保証するものではありません。実在の鉄道計画・事業評価の根拠としては使えません。
本アプリおよびソースコードは現状のまま提供され、利用により生じたいかなる損害についても作者は責任を負いません。
鉄道事業者名・駅名は既存路線を示すためにのみ使っており、各事業者とは関係ありません。

本アプリのコードとドキュメントの大部分は、AI（Anthropic の Claude）を使って作成しました。

## ライセンス

ソースコードにはオープンソースライセンスを付けていません（著作権者がすべての権利を保有します）。閲覧は自由ですが、複製・改変・再配布には著作権者の許可が必要です。

ビルド成果物に含まれる OSS（MapLibre GL JS: BSD-3-Clause、Chart.js: MIT、Preact: MIT ほか）の著作権表示とライセンス全文は、ビルド時に `third-party-licenses.md` として出力し、公開ページからも参照できます。

`public/data/` の加工済みデータの利用条件は、上記の各提供元の利用規約（CC BY 4.0 など）に従います。
