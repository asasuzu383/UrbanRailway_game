/** 出典表示（docs/data-sources.md の文言と揃える） */
const SOURCES: readonly { label: string; text: string; href: string }[] = [
  { label: '背景地図', text: '国土地理院「地理院タイル（淡色地図）」', href: 'https://maps.gsi.go.jp/development/ichiran.html' },
  { label: '人口', text: '総務省統計局「令和2年国勢調査 地域メッシュ統計」（e-Stat）を加工して作成', href: 'https://www.e-stat.go.jp/gis/statmap-search?type=1' },
  { label: '従業者数', text: '総務省統計局「令和3年経済センサス‐活動調査 地域メッシュ統計」（e-Stat）を加工して作成', href: 'https://www.e-stat.go.jp/gis/statmap-search?type=1' },
  { label: '鉄道路線・駅', text: '「国土数値情報（鉄道データ）」（国土交通省）を加工して作成', href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html' },
  { label: '駅別乗降客数', text: '「国土数値情報（駅別乗降客数データ）」（国土交通省）を加工して作成', href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-S12-2024.html' },
  { label: '行政区域', text: '「国土数値情報（行政区域データ）」（国土交通省）を加工して作成', href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html' },
  { label: '地価', text: '「国土数値情報（地価公示データ）」（国土交通省）を加工して作成', href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-L01-2026.html' },
  { label: '費用・運賃の単価', text: '国土交通省「基準単価・基準コスト算定データ」（令和4・5年度）、東京メトロ延伸事業の事業費ほか', href: 'https://www.mlit.go.jp/tetudo/content/001977442.pdf' },
];

export function SourcesPanel() {
  return (
    <details class="panel-section sources">
      <summary>出典</summary>
      <dl>
        {SOURCES.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>
              <a href={s.href} target="_blank" rel="noopener">{s.text}</a>
            </dd>
          </div>
        ))}
      </dl>
      <p class="note">
        本アプリの推計値は上記データをもとに独自のモデルで算出したものであり、各提供機関および鉄道事業者の見解ではありません。
      </p>
    </details>
  );
}
