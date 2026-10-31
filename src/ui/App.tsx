import { useEffect, useRef, useState } from 'preact/hooks';
import { loadBaseData, type BaseData } from '../data/loaders';
import { viewStore } from '../state/viewState';
import { MapView } from './map/MapView';
import { LayerPanel } from './panels/LayerPanel';
import { MeshLegend } from './panels/MeshLegend';
import { SourcesPanel } from './panels/SourcesPanel';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: BaseData };

export function App() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const mapEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadBaseData()
      .then((data) => setLoad({ status: 'ready', data }))
      .catch((e: unknown) => setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, []);

  useEffect(() => {
    if (load.status !== 'ready' || !mapEl.current) return;
    const view = new MapView(mapEl.current, load.data);
    // 開発時のデバッグ用（ブラウザのコンソールから参照）
    if (import.meta.env.DEV) (window as unknown as { __mapView: MapView }).__mapView = view;
    void view.applyViewState(viewStore.get());
    const unsubscribe = viewStore.subscribe((s) => void view.applyViewState(s));
    return () => {
      unsubscribe();
      view.destroy();
    };
  }, [load.status]);

  return (
    <div class="app">
      <header class="app-header">
        <h1>首都圏 鉄道新線計画シミュレーター</h1>
        <span class="badge">開発中</span>
      </header>
      <main class="app-main">
        <div class="map-wrap">
          <div ref={mapEl} class="map" />
          <MeshLegend />
          {load.status === 'loading' && <div class="map-overlay">データを読み込んでいます…</div>}
          {load.status === 'error' && <div class="map-overlay error" role="alert">{load.message}</div>}
        </div>
        <aside class="side-panel">
          <LayerPanel />
          <SourcesPanel />
        </aside>
      </main>
    </div>
  );
}
