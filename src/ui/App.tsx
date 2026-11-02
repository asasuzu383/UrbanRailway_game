import { useEffect, useRef, useState } from 'preact/hooks';
import { loadBaseData, type BaseData } from '../data/loaders';
import { defaultDemandParams } from '../config/demand';
import { CURRENT_REGION } from '../config/regions';
import { createDemandContext } from '../demand/context';
import { LandPriceIndex } from '../finance/landPrice';
import { scenarioStore, setDemandContext, setLandPrice } from '../state/appState';
import { editorStore } from '../state/editorState';
import { viewStore } from '../state/viewState';
import { EditorLayer, deleteVertex } from './map/EditorLayer';
import { MapView } from './map/MapView';
import { EditorPanel } from './panels/EditorPanel';
import { LayerPanel } from './panels/LayerPanel';
import { ParamsPanel } from './panels/ParamsPanel';
import { ResultsPanel } from './panels/ResultsPanel';
import { MeshLegend } from './panels/MeshLegend';
import { SourcesPanel } from './panels/SourcesPanel';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: BaseData };
type Tab = 'line' | 'results' | 'params' | 'layers';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'line', label: '路線' },
  { id: 'results', label: '結果' },
  { id: 'params', label: 'パラメータ' },
  { id: 'layers', label: '表示' },
];

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
        setLandPrice(data.landPrice ? new LandPriceIndex(data.landPrice) : null);
        setDemandContext(createDemandContext(data.zones, data.stations.stations, data.times, defaultDemandParams), data.services);
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
        <h1>{CURRENT_REGION.title}</h1>
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
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'line' && <EditorPanel />}
          {tab === 'results' && <ResultsPanel />}
          {tab === 'params' && <ParamsPanel />}
          {tab === 'layers' && <LayerPanel />}
          <SourcesPanel />
        </aside>
      </main>
    </div>
  );
}
