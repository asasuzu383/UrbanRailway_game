import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
// MapLibre 6 はワーカーをモジュールの隣から読むが、Vite の事前バンドルでは場所が変わるため明示する
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Feature, FeatureCollection, Point, Polygon, Position } from 'geojson';
import {
  INITIAL_BOUNDS,
  MESH_OPACITY,
  MESH_SCHEMES,
  OPERATOR_COLORS,
  OTHER_OPERATOR_COLOR,
  OTHER_OPERATOR_LABEL,
  operatorLabel,
  type MeshClassScheme,
} from '../../config/display';
import type { BaseData } from '../../data/loaders';
import { buildMeshFeatureCollection } from '../../data/meshGeoJson';
import type { StationRecord } from '../../data/schema';
import type { ViewState } from '../../state/viewState';

maplibregl.setWorkerUrl(workerUrl);

const GSI_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

/** 凡例・フィルタ上の事業者キー（固有色のない事業者は「その他」にまとめる） */
export function operatorKey(operator: string): string {
  return operator in OPERATOR_COLORS ? operator : OTHER_OPERATOR_LABEL;
}

interface StationProps {
  readonly idx: number;
  readonly name: string;
  readonly ridership: number;
}

function meshColorExpression(field: 'pop' | 'emp', scheme: MeshClassScheme): ExpressionSpecification {
  const stops: (number | string)[] = [];
  scheme.breaks.forEach((b, i) => {
    if (i > 0) stops.push(b);
    stops.push(scheme.colors[i]!);
  });
  return ['step', ['get', field], ...stops] as unknown as ExpressionSpecification;
}

function operatorColorExpression(): ExpressionSpecification {
  const pairs = Object.entries(OPERATOR_COLORS).flat();
  return ['match', ['get', 'operator'], ...pairs, OTHER_OPERATOR_COLOR] as unknown as ExpressionSpecification;
}

/** 対象地域の外側を覆う多角形（外周の大きな矩形から、地域の各ポリゴンの外周をくり抜く）。 */
function regionMask(region: BaseData['region']): Feature<Polygon> {
  const holes: Position[][] = [];
  for (const f of region.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (poly[0]) holes.push(poly[0]);
  }
  const outer: Position[] = [[120, 20], [160, 20], [160, 50], [120, 50], [120, 20]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, ...holes] } };
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number): string => n.toLocaleString('ja-JP');

/**
 * MapLibre 地図と既存データのレイヤーを管理する。
 * 状態は持たず、applyViewState() で渡された ViewState に表示を合わせる。
 */
export class MapView {
  readonly map: maplibregl.Map;
  private readonly data: BaseData;
  private readonly hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, maxWidth: '280px' });
  private lastState: ViewState | null = null;
  private ready: Promise<void>;

  constructor(container: HTMLElement, data: BaseData) {
    this.data = data;
    this.map = new maplibregl.Map({
      container,
      bounds: INITIAL_BOUNDS,
      minZoom: 7,
      maxZoom: 18,
      attributionControl: { compact: false },
      style: {
        version: 8,
        sources: {
          gsi: {
            type: 'raster',
            tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
            tileSize: 256,
            minzoom: 5,
            maxzoom: 18,
            attribution: GSI_ATTRIBUTION,
          },
        },
        // 背景の色（高速道路の緑など）が路線色と紛れないよう彩度を落とす
        layers: [{ id: 'gsi', type: 'raster', source: 'gsi', paint: { 'raster-saturation': -0.6 } }],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // 'load' は初期タイルの読み込み完了まで待つため、スタイルの準備ができた時点でレイヤーを追加する
    this.ready = new Promise((resolve) => this.map.once('style.load', () => {
      this.addLayers();
      resolve();
    }));
  }

  private addLayers(): void {
    const m = this.map;
    // 対象地域の外側を白く覆い、境界線を引く（地理院タイルの行政界の破線と区別するため）
    m.addSource('region-mask', { type: 'geojson', data: regionMask(this.data.region) });
    m.addLayer({
      id: 'region-mask',
      type: 'fill',
      source: 'region-mask',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.5 },
    });
    m.addSource('region', { type: 'geojson', data: this.data.region });
    m.addLayer({
      id: 'region-outline',
      type: 'line',
      source: 'region',
      paint: { 'line-color': '#6b6a66', 'line-width': 1.5 },
    });

    m.addSource('rail', { type: 'geojson', data: this.data.railLines });
    const lineWidth: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3, 15, 5];
    m.addLayer({
      id: 'rail-casing',
      type: 'line',
      source: 'rail',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 5, 15, 8],
        'line-opacity': 0.85,
      },
    });
    m.addLayer({
      id: 'rail-lines',
      type: 'line',
      source: 'rail',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': operatorColorExpression(), 'line-width': lineWidth },
    });
    // ホバー判定用の太い透明レイヤー（細い線でも拾いやすくする）
    m.addLayer({
      id: 'rail-hit',
      type: 'line',
      source: 'rail',
      paint: { 'line-color': '#000', 'line-width': 12, 'line-opacity': 0 },
    });

    m.addSource('stations', { type: 'geojson', data: this.stationFeatures(new Set()) });
    // 駅の円の大きさは乗降客数の平方根に比例（面積が乗降客数に比例）
    // 例: 新宿（約270万人/日）は z9 で半径 約5px、z15 で 約25px
    const r = (base: number, perSqrt: number): ExpressionSpecification =>
      ['+', base, ['*', ['sqrt', ['get', 'ridership']], perSqrt]] as unknown as ExpressionSpecification;
    m.addLayer({
      id: 'stations',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, r(1.5, 0.002), 12, r(2.5, 0.006), 15, r(4, 0.012)],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#333333',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 1.5],
      },
    });

    this.bindHover();
  }

  private stationFeatures(hiddenOperators: ReadonlySet<string>): FeatureCollection<Point, StationProps> {
    const features: Feature<Point, StationProps>[] = [];
    this.data.stations.stations.forEach((s, idx) => {
      const visible = s.operators.some((op) => !hiddenOperators.has(operatorKey(op)));
      if (!visible) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { idx, name: s.name, ridership: this.clusterRidership(s) ?? 0 },
      });
    });
    return { type: 'FeatureCollection', features };
  }

  /** 駅が属する乗降集計クラスタの最新年度の観測値（代表駅の値） */
  private clusterRidership(s: StationRecord, year = this.latestYear()): number | null {
    const rep = s.id === s.cluster ? s : this.data.stations.stations.find((x) => x.id === s.cluster);
    return rep?.ridership[String(year)] ?? null;
  }

  private latestYear(): number {
    const ys = this.data.stations.years;
    return ys[ys.length - 1]!;
  }

  private bindHover(): void {
    const m = this.map;
    const show = (e: MapLayerMouseEvent, html: string) => {
      m.getCanvas().style.cursor = 'pointer';
      this.hover.setLngLat(e.lngLat).setHTML(html).addTo(m);
    };
    const hide = () => {
      m.getCanvas().style.cursor = '';
      this.hover.remove();
    };

    m.on('mousemove', 'stations', (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as StationProps | undefined;
      if (p) show(e, this.stationHtml(p.idx));
    });
    m.on('mouseleave', 'stations', hide);

    m.on('mousemove', 'rail-hit', (e: MapLayerMouseEvent) => {
      // 駅の上では駅の情報を優先する
      if (m.queryRenderedFeatures(e.point, { layers: ['stations'] }).length > 0) return;
      const names = new Map<string, string>();
      for (const f of e.features ?? []) {
        const p = f.properties as { name: string; operator: string };
        names.set(`${p.operator}/${p.name}`, `${escapeHtml(operatorLabel(p.operator))} ${escapeHtml(p.name)}`);
      }
      show(e, [...names.values()].slice(0, 6).join('<br>'));
    });
    m.on('mouseleave', 'rail-hit', hide);
  }

  private stationHtml(idx: number): string {
    const s = this.data.stations.stations[idx]!;
    const lines = [...new Set(s.lines.map((li) => {
      const l = this.data.network.lines[li]!;
      return `${operatorLabel(l.operator)} ${l.name}`;
    }))];
    const years = this.data.stations.years;
    const rows: string[] = [];
    if (s.id !== s.cluster) {
      const rep = this.data.stations.stations.find((x) => x.id === s.cluster);
      rows.push(`乗降客数は「${escapeHtml(rep?.name ?? s.cluster)}」に合算`);
    } else {
      for (const y of [...years].reverse()) {
        const v = s.ridership[String(y)];
        rows.push(`${y}年度 乗降 ${v == null ? 'データなし' : `${fmt(v)} 人/日`}`);
      }
      if (s.partial) rows.push('※一部事業者のデータなし');
      if (s.includesShinkansen) rows.push('※新幹線の利用者を含む');
    }
    return `<div class="popup"><strong>${escapeHtml(s.name)}</strong>`
      + `<div class="popup-sub">${lines.map(escapeHtml).join('<br>')}</div>`
      + `<div>${rows.join('<br>')}</div></div>`;
  }

  async applyViewState(state: ViewState): Promise<void> {
    await this.ready;
    const prev = this.lastState;
    const m = this.map;
    const vis = (on: boolean) => (on ? 'visible' : 'none');

    for (const id of ['rail-casing', 'rail-lines', 'rail-hit']) m.setLayoutProperty(id, 'visibility', vis(state.showLines));
    m.setLayoutProperty('stations', 'visibility', vis(state.showStations));
    for (const id of ['region-mask', 'region-outline']) m.setLayoutProperty(id, 'visibility', vis(state.showRegion));

    if (!prev || prev.hiddenOperators !== state.hiddenOperators) {
      const hidden = [...state.hiddenOperators];
      const known = Object.keys(OPERATOR_COLORS);
      // 「その他」を隠す場合は固有色のある事業者以外を全部隠す
      const filter: ExpressionSpecification = state.hiddenOperators.has(OTHER_OPERATOR_LABEL)
        ? ['all', ['in', ['get', 'operator'], ['literal', known]], ['!', ['in', ['get', 'operator'], ['literal', hidden]]]]
        : ['!', ['in', ['get', 'operator'], ['literal', hidden]]];
      for (const id of ['rail-casing', 'rail-lines', 'rail-hit']) m.setFilter(id, filter);
      (m.getSource('stations') as GeoJSONSource).setData(this.stationFeatures(state.hiddenOperators));
    }

    if (state.meshMode !== 'none') this.ensureMeshLayer();
    if (m.getLayer('mesh-fill')) m.setLayoutProperty('mesh-fill', 'visibility', vis(state.meshMode !== 'none'));
    if (state.meshMode !== 'none' && state.meshMode !== prev?.meshMode) {
      m.setPaintProperty('mesh-fill', 'fill-color', meshColorExpression(state.meshMode, MESH_SCHEMES[state.meshMode]));
    }
    this.lastState = state;
  }

  /**
   * メッシュ（約5万ポリゴン）はワーカーでの処理に数秒かかり、同じワーカーで処理する路線・駅の
   * 表示まで遅らせるため、初めて表示を求められたときに追加する。
   */
  private ensureMeshLayer(): void {
    const m = this.map;
    if (m.getSource('mesh')) return;
    m.addSource('mesh', { type: 'geojson', data: buildMeshFeatureCollection(this.data.zones) });
    m.addLayer({
      id: 'mesh-fill',
      type: 'fill',
      source: 'mesh',
      paint: { 'fill-color': meshColorExpression('pop', MESH_SCHEMES.pop), 'fill-opacity': MESH_OPACITY },
    }, 'region-mask');
  }

  destroy(): void {
    this.map.remove();
  }
}
