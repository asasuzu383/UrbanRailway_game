import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent, MapLayerTouchEvent, MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { SNAP_MAX_M, SNAP_MIN_M, SNAP_RADIUS_PX } from '../../config/editor';
import type { LngLat, StructureType, UserLine } from '../../core/types';
import {
  appendVertex,
  insertVertex,
  moveVertex,
  removeVertex,
  type StationPlacement,
} from '../../network/lineModel';
import { findSnapTarget, type SnapCandidate } from '../../network/snap';
import { computeStore, scenarioStore } from '../../state/appState';
import { editorStore, type EditorState } from '../../state/editorState';

interface PieceProps {
  readonly afterIndex: number;
  readonly structure: StructureType | 'pending';
  /** 断面輸送量（片方向, 人/日）。需要推計の前は 0 */
  readonly load: number;
}

interface VertexProps {
  readonly id: string;
  readonly kind: 'station' | 'shape';
  readonly transfer: boolean;
  readonly selected: boolean;
}

const VERTEX_LAYERS = ['user-stations', 'user-shapes'];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 地図 1 ピクセルあたりの地上距離 [m]（Web メルカトル、512px タイル） */
function metersPerPixel(map: maplibregl.Map, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

/**
 * ユーザーの路線を地図に描き、地図上の編集操作（配置・挿入・ドラッグ・削除・スナップ）を受け付ける。
 * 編集はすべて scenarioStore / editorStore を通して行い、描画は store の変更に追従する。
 */
export class EditorLayer {
  private readonly map: maplibregl.Map;
  private readonly candidates: readonly SnapCandidate[];
  private dragging: { id: string; kind: 'station' | 'shape' } | null = null;
  private suppressClick = false;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(map: maplibregl.Map, candidates: readonly SnapCandidate[]) {
    this.map = map;
    this.candidates = candidates;
    this.addLayers();
    this.bindEvents();
    this.render();
    this.unsubscribers.push(scenarioStore.store.subscribe(() => this.render()));
    this.unsubscribers.push(computeStore.subscribe((s) => {
      if (s.status === 'idle') this.render();
    }));
    let lastFocus = editorStore.get().focus?.seq;
    this.unsubscribers.push(editorStore.subscribe((s) => {
      this.render();
      this.updateCursor(s);
      if (s.focus && s.focus.seq !== lastFocus) {
        lastFocus = s.focus.seq;
        this.map.easeTo({ center: [...s.focus.position], zoom: Math.max(this.map.getZoom(), 13) });
      }
    }));
    this.updateCursor(editorStore.get());
  }

  private addLayers(): void {
    const m = this.map;
    m.addSource('user-pieces', { type: 'geojson', data: EMPTY });
    m.addSource('user-vertices', { type: 'geojson', data: EMPTY });
    m.addSource('user-snap', { type: 'geojson', data: EMPTY });

    const color = ['get', 'color'] as unknown as string;
    // 線幅で断面輸送量（片方向）を表す: 0 人で 4px、5 万人で 10px、15 万人で 16px
    const width = ['interpolate', ['linear'], ['get', 'load'], 0, 4, 10000, 6, 50000, 10, 150000, 16] as unknown as number;
    const casingWidth = ['interpolate', ['linear'], ['get', 'load'], 0, 8, 10000, 10, 50000, 14, 150000, 20] as unknown as number;
    const isStructure = (s: string) => ['==', ['get', 'structure'], s] as maplibregl.FilterSpecification;

    m.addLayer({
      id: 'user-casing',
      type: 'line',
      source: 'user-pieces',
      filter: ['!=', ['get', 'structure'], 'pending'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': casingWidth },
    });
    // 地平: 実線、高架: 実線＋中央の白線、地下: 破線
    m.addLayer({
      id: 'user-line',
      type: 'line',
      source: 'user-pieces',
      filter: ['in', ['get', 'structure'], ['literal', ['atGrade', 'elevated']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width },
    });
    m.addLayer({
      id: 'user-line-elevated',
      type: 'line',
      source: 'user-pieces',
      filter: isStructure('elevated'),
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 13, 1.5, 16, 2] },
    });
    m.addLayer({
      id: 'user-line-underground',
      type: 'line',
      source: 'user-pieces',
      filter: isStructure('underground'),
      layout: { 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-dasharray': [1.2, 0.8] },
    });
    m.addLayer({
      id: 'user-pending',
      type: 'line',
      source: 'user-pieces',
      filter: isStructure('pending'),
      paint: { 'line-color': color, 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 },
    });
    m.addLayer({
      id: 'user-hit',
      type: 'line',
      source: 'user-pieces',
      paint: { 'line-color': '#000', 'line-width': 16, 'line-opacity': 0 },
    });

    m.addLayer({
      id: 'user-selected',
      type: 'circle',
      source: 'user-vertices',
      filter: ['get', 'selected'],
      paint: { 'circle-radius': 14, 'circle-color': '#2a78d6', 'circle-opacity': 0.25 },
    });
    m.addLayer({
      id: 'user-shapes',
      type: 'circle',
      source: 'user-vertices',
      filter: ['==', ['get', 'kind'], 'shape'],
      paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 2 },
    });
    m.addLayer({
      id: 'user-transfer-ring',
      type: 'circle',
      source: 'user-vertices',
      filter: ['get', 'transfer'],
      paint: { 'circle-radius': 10.5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': color, 'circle-stroke-width': 2 },
    });
    m.addLayer({
      id: 'user-stations',
      type: 'circle',
      source: 'user-vertices',
      filter: ['==', ['get', 'kind'], 'station'],
      paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 3 },
    });
    m.addLayer({
      id: 'user-snap',
      type: 'circle',
      source: 'user-snap',
      paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#2a78d6', 'circle-stroke-width': 2.5 },
    });
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  private render(): void {
    const line = scenarioStore.activeLine;
    const { selectedVertexId } = editorStore.get();
    const loads = new Map(computeStore.get().demand?.segments.map((s) => [s.fromStationId, s.forward]) ?? []);
    (this.map.getSource('user-pieces') as GeoJSONSource | undefined)?.setData(piecesOf(line, loads));
    const vertices: Feature<Point, VertexProps & { color: string }>[] = line.vertices.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [...v.position] },
      properties: {
        id: v.id,
        kind: v.kind,
        transfer: v.kind === 'station' && v.transferTo !== null,
        selected: v.id === selectedVertexId,
        color: line.color,
      },
    }));
    (this.map.getSource('user-vertices') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: vertices });
  }

  private showSnap(target: LngLat | null): void {
    const data: FeatureCollection = target
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [...target] } }] }
      : EMPTY;
    (this.map.getSource('user-snap') as GeoJSONSource | undefined)?.setData(data);
  }

  private updateCursor(s: EditorState): void {
    this.map.getCanvasContainer().classList.toggle('tool-place', s.tool !== 'select');
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /** 駅の配置位置を決める（既存駅の近くならスナップ） */
  private placement(lngLat: LngLat, kind: 'station' | 'shape'): StationPlacement {
    if (kind === 'shape') return { position: lngLat, transferTo: null };
    const radius = Math.min(SNAP_MAX_M, Math.max(SNAP_MIN_M, SNAP_RADIUS_PX * metersPerPixel(this.map, lngLat[1])));
    const hit = findSnapTarget(lngLat, this.candidates, radius);
    return hit ? { position: hit.position, transferTo: { id: hit.id, name: hit.name } } : { position: lngLat, transferTo: null };
  }

  private vertexAt(e: MapMouseEvent): VertexProps | null {
    const f = this.map.queryRenderedFeatures(e.point, { layers: VERTEX_LAYERS })[0];
    return (f?.properties as VertexProps | undefined) ?? null;
  }

  private bindEvents(): void {
    const m = this.map;

    m.on('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const ed = editorStore.get();
      const v = this.vertexAt(e);
      if (v) {
        editorStore.set({ selectedVertexId: v.id });
        return;
      }
      if (ed.tool === 'select') {
        editorStore.set({ selectedVertexId: null });
        return;
      }
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      const p = this.placement(lngLat, ed.tool);
      const piece = m.queryRenderedFeatures(e.point, { layers: ['user-hit'] })[0]?.properties as PieceProps | undefined;
      let vertexId = '';
      scenarioStore.updateLine((line) => {
        const r = piece
          ? insertVertex(line, piece.afterIndex, ed.tool as 'station' | 'shape', p, ed.defaultStructure)
          : appendVertex(line, ed.tool as 'station' | 'shape', p, ed.defaultStructure);
        vertexId = r.vertexId;
        return r.line;
      });
      editorStore.set({ selectedVertexId: vertexId });
      this.showSnap(null);
    });

    m.on('mousemove', (e) => {
      if (this.dragging) return;
      const ed = editorStore.get();
      if (ed.tool !== 'station' || this.vertexAt(e)) {
        this.showSnap(null);
        return;
      }
      const p = this.placement([e.lngLat.lng, e.lngLat.lat], 'station');
      this.showSnap(p.transferTo ? p.position : null);
    });
    m.on('mouseout', () => this.showSnap(null));

    // 頂点のドラッグ（マウス・タッチ）
    const startDrag = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
      const p = e.features?.[0]?.properties as VertexProps | undefined;
      if (!p) return;
      if ('originalEvent' in e && e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return;
      e.preventDefault(); // 地図のパンを止める
      this.dragging = { id: p.id, kind: p.kind };
      editorStore.set({ selectedVertexId: p.id });
      m.getCanvasContainer().classList.add('dragging');
    };
    for (const layer of VERTEX_LAYERS) {
      m.on('mousedown', layer, startDrag);
      m.on('touchstart', layer, startDrag);
    }
    const moveDrag = (e: MapMouseEvent | MapLayerTouchEvent) => {
      const d = this.dragging;
      if (!d) return;
      const p = this.placement([e.lngLat.lng, e.lngLat.lat], d.kind);
      this.showSnap(p.transferTo ? p.position : null);
      scenarioStore.updateLine((line) => moveVertex(line, d.id, p), { transient: true });
    };
    const endDrag = () => {
      if (!this.dragging) return;
      this.dragging = null;
      this.suppressClick = true; // ドラッグ後の click で駅が追加されないように
      setTimeout(() => (this.suppressClick = false), 0);
      m.getCanvasContainer().classList.remove('dragging');
      this.showSnap(null);
      scenarioStore.commitTransient();
    };
    m.on('mousemove', moveDrag);
    m.on('touchmove', moveDrag);
    m.on('mouseup', endDrag);
    m.on('touchend', endDrag);

    // 右クリックで削除
    for (const layer of VERTEX_LAYERS) {
      m.on('contextmenu', layer, (e: MapLayerMouseEvent) => {
        const p = e.features?.[0]?.properties as VertexProps | undefined;
        if (!p) return;
        e.originalEvent.preventDefault(); // ブラウザのコンテキストメニューを出さない
        deleteVertex(p.id);
      });
    }
  }

  destroy(): void {
    for (const u of this.unsubscribers) u();
  }
}

export function deleteVertex(id: string): void {
  scenarioStore.updateLine((line) => removeVertex(line, id, editorStore.get().defaultStructure));
  if (editorStore.get().selectedVertexId === id) editorStore.set({ selectedVertexId: null });
}

/**
 * 路線を「隣り合う頂点の組」ごとの線分に分ける。挿入位置（afterIndex）と区間の構造を属性に持つ。
 * 先頭駅より前・最終駅より後は未完成（pending）。
 */
function piecesOf(line: UserLine, loads: ReadonlyMap<string, number>): FeatureCollection<LineString, PieceProps & { color: string }> {
  const structureOf = new Map(line.segments.map((s) => [s.fromStationId, s.structure]));
  const firstStation = line.vertices.findIndex((v) => v.kind === 'station');
  let lastStation = -1;
  line.vertices.forEach((v, i) => {
    if (v.kind === 'station') lastStation = i;
  });
  const features: Feature<LineString, PieceProps & { color: string }>[] = [];
  let current: StructureType | 'pending' = 'pending';
  let load = 0;
  for (let i = 0; i + 1 < line.vertices.length; i++) {
    const a = line.vertices[i]!;
    const b = line.vertices[i + 1]!;
    if (a.kind === 'station') {
      current = structureOf.get(a.id) ?? 'pending';
      load = loads.get(a.id) ?? 0;
    }
    const inside = firstStation >= 0 && i >= firstStation && i + 1 <= lastStation;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[...a.position], [...b.position]] },
      properties: { afterIndex: i, structure: inside ? current : 'pending', load: inside ? load : 0, color: line.color },
    });
  }
  return { type: 'FeatureCollection', features };
}
