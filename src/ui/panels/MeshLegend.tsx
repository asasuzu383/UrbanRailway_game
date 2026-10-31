import { MESH_OPACITY, MESH_SCHEMES } from '../../config/display';
import { viewStore } from '../../state/viewState';
import { useStore } from '../hooks';

const fmt = (n: number): string => n.toLocaleString('ja-JP');

/** メッシュ階級区分図の凡例（地図の上に重ねて表示） */
export function MeshLegend() {
  const { meshMode } = useStore(viewStore);
  if (meshMode === 'none') return null;
  const scheme = MESH_SCHEMES[meshMode];
  return (
    <div class="map-legend" role="group" aria-label={`${scheme.label}の凡例`}>
      <div class="map-legend-title">{scheme.label}</div>
      <div class="map-legend-unit">{scheme.unit}</div>
      <ul>
        {scheme.breaks.map((b, i) => {
          const next = scheme.breaks[i + 1];
          const label = next === undefined ? `${fmt(b)} 以上` : `${fmt(b)} – ${fmt(next)}`;
          return (
            <li key={b}>
              <span class="swatch" style={{ background: scheme.colors[i], opacity: MESH_OPACITY }} />
              {label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
