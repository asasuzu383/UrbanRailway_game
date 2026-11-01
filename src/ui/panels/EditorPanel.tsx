import { Fragment } from 'preact';
import { useRef } from 'preact/hooks';
import { STRUCTURE_LABELS, STRUCTURE_ORDER } from '../../config/editor';
import type { StructureType } from '../../core/types';
import {
  renameStation,
  reverseLine,
  setAllSegmentsStructure,
  setSegmentStructure,
} from '../../network/lineModel';
import { computeStore, scenarioStore } from '../../state/appState';
import { editorStore, focusOn, type EditorTool } from '../../state/editorState';
import { ScenarioFormatError, parseScenarioJson, serializeScenario } from '../../state/scenarioIO';
import { useStore } from '../hooks';
import { deleteVertex } from '../map/EditorLayer';

const TOOLS: readonly { value: EditorTool; label: string; hint: string }[] = [
  { value: 'select', label: '選択・移動', hint: '駅や中間点をドラッグで移動（Esc）' },
  { value: 'station', label: '駅を置く', hint: 'クリックで駅を追加。路線上をクリックすると途中に挿入' },
  { value: 'shape', label: '中間点を置く', hint: 'クリックで曲線用の中間点を追加。路線上をクリックすると途中に挿入' },
];

const km = (x: number): string => `${x.toFixed(1)} km`;
const people = (x: number): string => `${Math.round(x).toLocaleString('ja-JP')} 人`;

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function EditorPanel() {
  const { scenario, past, future } = useStore(scenarioStore.store);
  const ed = useStore(editorStore);
  const compute = useStore(computeStore);
  const fileInput = useRef<HTMLInputElement>(null);
  const line = scenario.lines[0]!;
  const geo = compute.geometry;
  const stations = line.vertices.filter((v) => v.kind === 'station');
  const structureOf = new Map(line.segments.map((s) => [s.fromStationId, s.structure]));
  const lengthOf = new Map(geo?.segments.map((s) => [s.fromStationId, s.lengthKm]) ?? []);
  const demand = compute.demand;
  const ridershipOf = new Map(demand?.stations.map((s) => [s.stationId, s]) ?? []);
  const loadOf = new Map(demand?.segments.map((s) => [s.fromStationId, s]) ?? []);
  const update = scenarioStore.updateLine.bind(scenarioStore);

  const onImport = async (file: File) => {
    try {
      const imported = parseScenarioJson(await file.text());
      if (line.vertices.length > 0 && !window.confirm('現在の路線を読み込んだ路線で置き換えます。よろしいですか？（元に戻すで戻せます）')) return;
      scenarioStore.replace(imported);
      editorStore.set({ selectedVertexId: null });
    } catch (e) {
      window.alert(e instanceof ScenarioFormatError ? `読み込めませんでした: ${e.message}` : `読み込めませんでした: ${String(e)}`);
    }
  };

  const exportJson = () => {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    downloadText(`urbanrailway-${date}.json`, serializeScenario(scenario));
  };

  const clearAll = () => {
    if (!window.confirm('路線の駅と中間点をすべて消去します。よろしいですか？（元に戻すで戻せます）')) return;
    update((l) => ({ ...l, vertices: [], segments: [] }));
    editorStore.set({ selectedVertexId: null });
  };

  return (
    <div class="editor">
      <section class="panel-section">
        <div class="line-header">
          <input
            class="line-color"
            type="color"
            value={line.color}
            aria-label="路線の色"
            onChange={(e) => update((l) => ({ ...l, color: e.currentTarget.value }))}
          />
          <input
            class="line-name"
            type="text"
            value={line.name}
            aria-label="路線名"
            onChange={(e) => {
              const name = e.currentTarget.value.trim();
              if (name) update((l) => ({ ...l, name }));
            }}
          />
        </div>

        <div class="segmented tools" role="radiogroup" aria-label="編集ツール">
          {TOOLS.map((t) => (
            <label key={t.value} class={ed.tool === t.value ? 'active' : ''}>
              <input
                type="radio"
                name="tool"
                checked={ed.tool === t.value}
                onChange={() => editorStore.set({ tool: t.value })}
              />
              {t.label}
            </label>
          ))}
        </div>
        <p class="hint">{TOOLS.find((t) => t.value === ed.tool)?.hint}</p>

        <div class="field-row">
          <span>延伸する区間の構造</span>
          <StructureSelect
            value={ed.defaultStructure}
            onChange={(s) => editorStore.set({ defaultStructure: s })}
            label="延伸する区間の構造"
          />
        </div>

        <div class="button-row">
          <button type="button" disabled={past.length === 0} onClick={() => scenarioStore.undo()} aria-keyshortcuts="Control+Z">元に戻す</button>
          <button type="button" disabled={future.length === 0} onClick={() => scenarioStore.redo()} aria-keyshortcuts="Control+Y">やり直す</button>
          <button type="button" disabled={stations.length < 2} onClick={() => update(reverseLine)} aria-label="向きを反転" title="終点側と起点側を入れ替える（起点側へ延伸したいとき）">向きを反転</button>
        </div>
      </section>

      <section class="panel-section">
        <h2>
          概要 {compute.status === 'pending' && <span class="pending">計算中…</span>}
        </h2>
        {stations.length < 2 ? (
          <p class="hint">地図をクリックして駅を 2 つ以上置くと路線になります。</p>
        ) : (
          <dl class="summary">
            <dt>営業キロ</dt>
            <dd>{km(geo?.totalKm ?? 0)}</dd>
            <dt>駅数</dt>
            <dd>{stations.length} 駅（うち接続駅 {stations.filter((s) => s.transferTo).length}）</dd>
            <dt>構造別</dt>
            <dd>
              {STRUCTURE_ORDER.filter((s) => (geo?.kmByStructure[s] ?? 0) > 0)
                .map((s) => `${STRUCTURE_LABELS[s]} ${km(geo!.kmByStructure[s])}`)
                .join(' / ')}
            </dd>
            {demand && (
              <>
                <dt>輸送人員</dt>
                <dd><strong>{people(demand.dailyPassengers)}</strong>/日</dd>
                <dt>内訳</dt>
                <dd>
                  新線内 {people(demand.tripsByType.local)} / 既存線と乗継 {people(demand.tripsByType.toExisting)} / 既存線からの経路転換 {people(demand.tripsByType.through)}
                </dd>
                <dt>輸送人キロ</dt>
                <dd>{Math.round(demand.dailyPassengerKm).toLocaleString('ja-JP')} 人キロ/日</dd>
                <dt>平均乗車距離</dt>
                <dd>{demand.dailyPassengers > 0 ? km(demand.dailyPassengerKm / demand.dailyPassengers) : '-'}</dd>
              </>
            )}
          </dl>
        )}
        {compute.error && <p class="hint error">需要推計でエラーが発生しました: {compute.error}</p>}
        {!demand && stations.length >= 2 && <p class="hint">需要推計は基礎データの読み込み後に表示されます。</p>}
        {demand && stations.length >= 2 && (
          <p class="hint">
            人数は 1 日平均（年間平均日）の推計です。手法と精度は docs/calibration.md を参照。
          </p>
        )}
      </section>

      {stations.length > 0 && (
        <section class="panel-section">
          <h2>駅と区間</h2>
          {line.segments.length > 1 && (
            <div class="field-row">
              <span>全区間を</span>
              <StructureSelect
                value={null}
                onChange={(s) => update((l) => setAllSegmentsStructure(l, s))}
                label="全区間の構造"
              />
            </div>
          )}
          <ol class="station-list">
            {stations.map((s, i) => (
              <Fragment key={s.id}>
                <li class={`station-row ${ed.selectedVertexId === s.id ? 'selected' : ''}`}>
                  <button
                    type="button"
                    class="station-index"
                    aria-label={`地図で${s.name}を表示`}
                    title="地図でこの駅を表示"
                    onClick={() => {
                      editorStore.set({ selectedVertexId: s.id });
                      focusOn(s.position);
                    }}
                  >
                    {i + 1}
                  </button>
                  <input
                    type="text"
                    value={s.name}
                    aria-label={`${i + 1}番目の駅名`}
                    onFocus={() => editorStore.set({ selectedVertexId: s.id })}
                    onChange={(e) => update((l) => renameStation(l, s.id, e.currentTarget.value))}
                  />
                  {s.transferTo && <span class="badge transfer" title="既存駅と接続（乗換駅）">乗換</span>}
                  {ridershipOf.has(s.id) && (
                    <span
                      class="station-ridership"
                      title={`新線の乗降人員（1日）。駅勢圏 ${people(ridershipOf.get(s.id)!.fromCatchment)}、乗換 ${people(ridershipOf.get(s.id)!.fromTransfer)}`}
                    >
                      {Math.round(ridershipOf.get(s.id)!.ridership).toLocaleString('ja-JP')}
                    </span>
                  )}
                  <button type="button" class="icon-button" aria-label={`${s.name}を削除`} title="削除" onClick={() => deleteVertex(s.id)}>
                    ×
                  </button>
                </li>
                {i + 1 < stations.length && (
                  <li class="segment-row">
                    <span class="segment-length">{km(lengthOf.get(s.id) ?? 0)}</span>
                    {loadOf.has(s.id) && (
                      <span class="segment-load" title="断面輸送量（片方向, 人/日）">
                        {Math.round(loadOf.get(s.id)!.forward).toLocaleString('ja-JP')} 人
                      </span>
                    )}
                    <StructureSelect
                      value={structureOf.get(s.id) ?? 'atGrade'}
                      onChange={(st) => update((l) => setSegmentStructure(l, s.id, st))}
                      label={`${s.name}〜${stations[i + 1]!.name}の構造`}
                    />
                  </li>
                )}
              </Fragment>
            ))}
          </ol>
        </section>
      )}

      <section class="panel-section">
        <h2>保存</h2>
        <p class="hint">編集内容はこのブラウザに自動保存されます。</p>
        <div class="button-row">
          <button type="button" onClick={exportJson} disabled={line.vertices.length === 0}>JSON に書き出す</button>
          <button type="button" onClick={() => fileInput.current?.click()}>JSON を読み込む</button>
          <button type="button" class="danger" onClick={clearAll} disabled={line.vertices.length === 0}>全消去</button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void onImport(f);
          }}
        />
      </section>

      <details class="panel-section help">
        <summary>操作方法</summary>
        <ul>
          <li>「駅を置く」で地図をクリック: 終点側に駅を追加。既存駅の近くでは自動で接続駅（乗換駅）になります。</li>
          <li>路線の上をクリック: その位置に駅（中間点）を挿入。</li>
          <li>駅・中間点をドラッグ: 移動。右クリックまたは Delete キー: 削除。</li>
          <li>起点側へ延伸したいときは「向きを反転」してから追加します。</li>
          <li>線の表示: 実線＝地平、白線入り＝高架、破線＝地下、細い点線＝未完成部分（駅と駅の間にない中間点）。</li>
          <li>Ctrl+Z / Ctrl+Y: 元に戻す / やり直す。Esc: 選択・移動に戻る。</li>
        </ul>
      </details>
    </div>
  );
}

function StructureSelect(props: { value: StructureType | null; onChange: (s: StructureType) => void; label: string }) {
  return (
    <select
      aria-label={props.label}
      value={props.value ?? ''}
      onChange={(e) => {
        const v = e.currentTarget.value as StructureType | '';
        if (v) props.onChange(v);
      }}
    >
      {props.value === null && <option value="">選択…</option>}
      {STRUCTURE_ORDER.map((s) => (
        <option key={s} value={s}>{STRUCTURE_LABELS[s]}</option>
      ))}
    </select>
  );
}
