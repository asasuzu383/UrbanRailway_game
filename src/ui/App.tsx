import { useEffect, useRef, useState } from 'preact/hooks';
import { loadBaseData, type BaseData } from '../data/loaders';
import { defaultDemandParams } from '../config/demand';
import { createDemandContext } from '../demand/context';
import { scenarioStore, setDemandContext } from '../state/appState';
import { editorStore } from '../state/editorState';
import { viewStore } from '../state/viewState';
import { EditorLayer, deleteVertex } from './map/EditorLayer';
import { MapView } from './map/MapView';
import { EditorPanel } from './panels/EditorPanel';
import { LayerPanel } from './panels/LayerPanel';
import { MeshLegend } from './panels/MeshLegend';
import { SourcesPanel } from './panels/SourcesPanel';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: BaseData };
type Tab = 'line' | 'layers';

/** 入力欄にフォーカスがあるときはショートカットを無効にする */
const isTyping = (e: KeyboardEvent): boolean =>
  e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName));

function handleShortcut(e: KeyboardEvent): void {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    scenarioStore.undo();
  } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    scenarioStore.redo();
  } else if (e.key === 'Escape') {
    editorStore.set({ tool: 'select', selectedVertexId: null });
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    const id = editorStore.get().selectedVertexId;
    if (id) deleteVertex(id);
  } else {
    return;
  }
  e.preventDefault();
}

export function App() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [tab, setTab] = useState<Tab>('line');
  const mapEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadBaseData()
      .then((data) => {
        setDemandContext(createDemandContext(data.zones, data.stations.stations, data.times, defaultDemandParams));
        setLoad({ status: 'ready', data });
      })
      .catch((e: unknown) => setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, []);

  useEffect(() => {
    if (load.status !== 'ready' || !mapEl.current) return;
    const view = new MapView(mapEl.current, load.data);
    // 開発時のデバッグ用（ブラウザのコンソールから参照）
    if (import.meta.env.DEV) (window as unknown as { __mapView: MapView }).__mapView = view;
    void view.applyViewState(viewStore.get());
    const unsubscribe = viewStore.subscribe((s) => void view.applyViewState(s));

    let editor: EditorLayer | null = null;
    let disposed = false;
    void view.whenReady().then(() => {
      if (disposed) return;
      const candidates = load.data.stations.stations.map((s) => ({ id: s.id, name: s.name, position: [s.lng, s.lat] as const }));
      editor = new EditorLayer(view.map, candidates);
    });
    window.addEventListener('keydown', handleShortcut);
    return () => {
      disposed = true;
      window.removeEventListener('keydown', handleShortcut);
      editor?.destroy();
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
          <div class="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'line'} class={tab === 'line' ? 'active' : ''} onClick={() => setTab('line')}>
              路線
            </button>
            <button type="button" role="tab" aria-selected={tab === 'layers'} class={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>
              表示
            </button>
          </div>
          {tab === 'line' ? <EditorPanel /> : <LayerPanel />}
          <SourcesPanel />
        </aside>
      </main>
    </div>
  );
}
