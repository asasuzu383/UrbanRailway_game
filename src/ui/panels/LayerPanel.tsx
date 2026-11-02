import { OPERATOR_COLORS, OTHER_OPERATOR_COLOR, OTHER_OPERATOR_LABEL, operatorLabel } from '../../config/display';
import { viewStore, type MeshMode } from '../../state/viewState';
import { useStore } from '../hooks';

const OPERATOR_KEYS = [...Object.keys(OPERATOR_COLORS), OTHER_OPERATOR_LABEL];

const MESH_OPTIONS: readonly { value: MeshMode; label: string }[] = [
  { value: 'none', label: '表示しない' },
  { value: 'pop', label: '夜間人口' },
  { value: 'emp', label: '従業者数' },
];

export function LayerPanel() {
  const s = useStore(viewStore);

  const toggleOperator = (key: string) => {
    viewStore.set((prev) => {
      const hidden = new Set(prev.hiddenOperators);
      if (hidden.has(key)) hidden.delete(key);
      else hidden.add(key);
      return { ...prev, hiddenOperators: hidden };
    });
  };
  const setAllOperators = (visible: boolean) =>
    viewStore.set({ hiddenOperators: visible ? new Set() : new Set(OPERATOR_KEYS) });

  return (
    <section class="panel-section" aria-labelledby="layers-heading">
      <h2 id="layers-heading">表示</h2>

      <fieldset>
        <legend>人口・従業者メッシュ（500m）</legend>
        <div class="segmented" role="radiogroup">
          {MESH_OPTIONS.map((o) => (
            <label key={o.value} class={s.meshMode === o.value ? 'active' : ''}>
              <input
                type="radio"
                name="mesh"
                value={o.value}
                checked={s.meshMode === o.value}
                onChange={() => viewStore.set({ meshMode: o.value })}
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>
          <label class="check">
            <input type="checkbox" checked={s.showLines} onChange={() => viewStore.set({ showLines: !s.showLines })} />
            既存路線
          </label>
        </legend>
        <ul class="operator-list" aria-label="事業者別の表示">
          {OPERATOR_KEYS.map((key) => (
            <li key={key}>
              <label class="check">
                <input
                  type="checkbox"
                  checked={!s.hiddenOperators.has(key)}
                  disabled={!s.showLines}
                  onChange={() => toggleOperator(key)}
                />
                <span class="swatch" style={{ background: OPERATOR_COLORS[key] ?? OTHER_OPERATOR_COLOR }} />
                {key === OTHER_OPERATOR_LABEL ? key : operatorLabel(key)}
              </label>
            </li>
          ))}
        </ul>
        <div class="button-row">
          <button type="button" disabled={!s.showLines} onClick={() => setAllOperators(true)}>すべて表示</button>
          <button type="button" disabled={!s.showLines} onClick={() => setAllOperators(false)}>すべて隠す</button>
        </div>
        <p class="quality-legend" aria-label="既存線の運行データの品質">
          <span><i />時刻表・公表資料</span>
          <span><i class="provisional" />仮置き（薄く表示）</span>
        </p>
        <p class="hint">
          既存線の所要時間・本数のもと: 時刻表（ODPT のオープンデータ）、公表資料（国交省の混雑率データ・各社の停車駅）、仮置き（路線ごとの表定速度）。
          路線にマウスを重ねると表示します。
        </p>
      </fieldset>

      <label class="check">
        <input type="checkbox" checked={s.showStations} onChange={() => viewStore.set({ showStations: !s.showStations })} />
        既存駅（円の面積 ∝ 乗降客数）
      </label>
      <label class="check">
        <input type="checkbox" checked={s.showRegion} onChange={() => viewStore.set({ showRegion: !s.showRegion })} />
        対象地域の境界
      </label>
    </section>
  );
}
