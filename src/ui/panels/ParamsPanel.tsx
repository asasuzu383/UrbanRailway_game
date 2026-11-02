import type { CostParams } from '../../config/cost';
import { CURRENT_REGION } from '../../config/regions';
import { STRUCTURE_LABELS, STRUCTURE_ORDER } from '../../config/editor';
import { costParamsStore, resetCostParams, setCostParam } from '../../state/costParams';
import { useStore } from '../hooks';

type Path = readonly (string | number)[];

function getIn(obj: unknown, path: Path): number {
  return path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], obj) as number;
}

interface FieldProps {
  readonly label: string;
  readonly path: Path;
  readonly unit: string;
  /** 表示値 = 内部値 / scale */
  readonly scale?: number;
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
  readonly params: CostParams;
}

function NumberField({ label, path, unit, scale = 1, step = 1, min = 0, max, params }: FieldProps) {
  const value = getIn(params, path) / scale;
  const def = getIn(CURRENT_REGION.costParams, path) / scale;
  const changed = Math.abs(value - def) > 1e-9;
  const id = `param-${path.join('-')}`;
  return (
    <div class={`param-row ${changed ? 'changed' : ''}`}>
      <label for={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={Number(value.toFixed(6))}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v) && v >= min && (max === undefined || v <= max)) setCostParam(path, v * scale);
          else e.currentTarget.value = String(value);
        }}
      />
      <span class="param-unit">{unit}</span>
      {changed && <span class="param-default" title="初期値">初期値 {Number(def.toFixed(4)).toLocaleString('ja-JP')}</span>}
    </div>
  );
}

const OKU = 1e8;

export function ParamsPanel() {
  const { params } = useStore(costParamsStore);
  const f = (props: Omit<FieldProps, 'params'>) => <NumberField key={props.path.join('.')} {...props} params={params} />;

  return (
    <div class="params">
      <section class="panel-section">
        <h2>主要パラメータ</h2>
        <p class="hint">変更すると収支をすぐに再計算します。値はこのブラウザに保存されます。根拠は src/config/cost.ts のコメントと docs/design.md §6。</p>
        <button type="button" onClick={() => window.confirm('すべてのパラメータを初期値に戻しますか？') && resetCostParams()}>
          すべて初期値に戻す
        </button>
      </section>

      <section class="panel-section">
        <h3>運賃</h3>
        {f({ label: '定期外の賃率', path: ['fare', 'nonCommuterRatePerKm'], unit: '円/人キロ', step: 0.5 })}
        {f({ label: '定期の割引率', path: ['fare', 'commuterDiscount'], unit: '%', scale: 0.01, step: 1, max: 100 })}
        {f({ label: '定期の割合（人キロ）', path: ['fare', 'commuterShare'], unit: '%', scale: 0.01, step: 1, max: 100 })}
        {f({ label: '最低運賃（初乗り）', path: ['fare', 'minimumFare'], unit: '円', step: 10 })}
        <p class="hint">
          平均賃率 {(params.fare.nonCommuterRatePerKm * (1 - params.fare.commuterShare * params.fare.commuterDiscount)).toFixed(1)} 円/人キロ
          （関東大手民鉄の実績 約 10〜13.5 円）
        </p>
      </section>

      <section class="panel-section">
        <h3>建設費</h3>
        {STRUCTURE_ORDER.map((s) => f({ label: `線路 km 単価（${STRUCTURE_LABELS[s]}）`, path: ['construction', 'trackPerKm', s], unit: '億円/km', scale: OKU }))}
        {STRUCTURE_ORDER.map((s) => f({ label: `駅単価（${STRUCTURE_LABELS[s]}）`, path: ['construction', 'stationEach', s], unit: '億円/駅', scale: OKU }))}
        {f({ label: '接続駅の単価係数', path: ['construction', 'transferStationFactor'], unit: '倍', step: 0.05 })}
        {f({ label: '車両単価', path: ['construction', 'carPrice'], unit: '億円/両', scale: OKU, step: 0.1 })}
        {f({ label: '用地費の補正係数（対 公示価格）', path: ['land', 'priceFactor'], unit: '倍', step: 0.1 })}
      </section>

      <section class="panel-section">
        <h3>運行・経費</h3>
        {f({ label: '運行本数（片道）', path: ['service', 'trainsPerDayOneWay'], unit: '本/日', step: 10, min: 1 })}
        {f({ label: 'ピーク時の運行本数（片道）', path: ['service', 'peakTrainsPerHour'], unit: '本/時', min: 1 })}
        {f({ label: '編成両数', path: ['service', 'carsPerTrain'], unit: '両', min: 1, max: 16 })}
        {f({ label: '運転・車両保守費', path: ['operating', 'perCarKm'], unit: '円/車両キロ', step: 10 })}
        {STRUCTURE_ORDER.map((s) => f({ label: `線路保守費（${STRUCTURE_LABELS[s]}）`, path: ['operating', 'trackMaintenancePerKmYear', s], unit: '億円/km・年', scale: OKU, step: 0.1 }))}
        {STRUCTURE_ORDER.map((s) => f({ label: `駅の運営費（${STRUCTURE_LABELS[s]}）`, path: ['operating', 'stationPerYear', s], unit: '億円/駅・年', scale: OKU, step: 0.1 }))}
        {f({ label: '管理費などの比率', path: ['operating', 'overheadRatio'], unit: '%', scale: 0.01 })}
      </section>

      <section class="panel-section">
        <h3>評価</h3>
        {f({ label: '割引率', path: ['evaluation', 'discountRate'], unit: '%/年', scale: 0.01, step: 0.5, max: 20 })}
        {f({ label: '休日の利用者（平日比）', path: ['annual', 'holidayFactor'], unit: '倍', step: 0.05, max: 2 })}
      </section>
    </div>
  );
}
