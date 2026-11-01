import { STRUCTURE_LABELS, STRUCTURE_ORDER } from '../../config/editor';
import { computeStore, financeStore, scenarioStore } from '../../state/appState';
import { costParamsStore } from '../../state/costParams';
import { focusOn, editorStore } from '../../state/editorState';
import { int, oku, people, years } from '../format';
import { useStore } from '../hooks';
import { CashflowChart } from './CashflowChart';

/** 割合の横棒（表の中で内訳の大きさを示す） */
function Bar({ value, max }: { value: number; max: number }) {
  return <span class="bar" style={{ width: `${max > 0 ? Math.max(0, (value / max) * 100) : 0}%` }} />;
}

export function ResultsPanel() {
  const compute = useStore(computeStore);
  const { finance, error } = useStore(financeStore);
  const { params } = useStore(costParamsStore);
  const { scenario } = useStore(scenarioStore.store);
  const line = scenario.lines[0]!;
  const geo = compute.geometry;
  const demand = compute.demand;

  if (!geo || geo.stations.length < 2) {
    return <section class="panel-section"><p class="hint">「路線」タブで駅を 2 つ以上置くと、ここに結果が表示されます。</p></section>;
  }
  if (!demand || !finance) {
    return (
      <section class="panel-section">
        <p class="hint">{error ? `収支の計算でエラーが発生しました: ${error}` : '計算中です…'}</p>
      </section>
    );
  }

  const c = finance.construction;
  const o = finance.steadyOperatingCost;
  const nameOf = new Map(line.vertices.map((v) => [v.id, v.kind === 'station' ? v.name : '']));
  const structRows = STRUCTURE_ORDER.filter((s) => c.byStructure[s].lengthKm > 0 || c.byStructure[s].stationCount > 0);
  const maxPart = Math.max(...structRows.map((s) => c.byStructure[s].trackCost + c.byStructure[s].stationCost + c.byStructure[s].landCost), c.vehicles.cost);
  const opexRows: [string, number][] = [['列車の運行（運転・車両保守）', o.train], ['線路・電気設備の保守', o.track], ['駅の運営', o.stations], ['管理費など', o.overhead]];
  const maxOpex = Math.max(...opexRows.map((r) => r[1]));
  const maxRidership = Math.max(...demand.stations.map((s) => s.ridership), 1);

  return (
    <div class="results">
      <section class="panel-section">
        <h2>
          収支の見通し {compute.status === 'pending' && <span class="pending">計算中…</span>}
        </h2>
        <div class={`verdict ${finance.isProfitable ? 'good' : 'bad'}`} role="status">
          <span class="verdict-icon" aria-hidden="true">{finance.isProfitable ? '✓' : '✕'}</span>
          <div>
            <strong>{finance.isProfitable ? '黒字' : '赤字'}</strong>（営業収支 {oku(finance.steadyOperatingBalance)}/年）
            <div class="verdict-sub">
              {!finance.isProfitable
                ? '運賃収入が運行経費を下回るため、建設費は回収不能です'
                : finance.discountedPaybackYears !== null
                  ? `建設費は ${years(finance.simplePaybackYears)}（割引率 ${(params.evaluation.discountRate * 100).toFixed(1)}% では ${years(finance.discountedPaybackYears)}）で回収`
                  : finance.simplePaybackYears !== null
                    ? `建設費の回収は単純計算で ${years(finance.simplePaybackYears)}。割引率 ${(params.evaluation.discountRate * 100).toFixed(1)}% では ${params.evaluation.maxYears} 年以内に回収できません`
                    : `黒字ですが、建設費は ${params.evaluation.maxYears} 年以内に回収できません`}
            </div>
          </div>
        </div>

        <dl class="kpis">
          <div><dt>営業キロ / 駅数</dt><dd>{geo.totalKm.toFixed(1)} km / {geo.stations.length} 駅</dd></div>
          <div>
            <dt>輸送人員（日平均）</dt>
            <dd>{people(demand.dailyPassengers)}</dd>
            <small>平日 {int(finance.weekdayPassengers)} / 休日 {int(finance.holidayPassengers)}</small>
          </div>
          <div><dt>建設費</dt><dd>{oku(c.total)}</dd></div>
          <div><dt>年間運賃収入</dt><dd>{oku(finance.steadyRevenue)}</dd><small>平均運賃 {int(finance.averageFare)} 円/人</small></div>
          <div><dt>年間運行経費</dt><dd>{oku(o.total)}</dd></div>
          <div><dt>営業収支（減価償却前）</dt><dd class={finance.isProfitable ? 'pos' : 'neg'}>{oku(finance.steadyOperatingBalance)}</dd></div>
          <div><dt>単純回収年数</dt><dd>{years(finance.simplePaybackYears)}</dd></div>
          <div><dt>割引回収年数（{(params.evaluation.discountRate * 100).toFixed(1)}%）</dt><dd>{years(finance.discountedPaybackYears)}</dd></div>
        </dl>
      </section>

      <section class="panel-section">
        <h2>累積キャッシュフロー</h2>
        <CashflowChart finance={finance} discountRate={params.evaluation.discountRate} />
        <p class="hint">
          開業時点に建設費を一括計上し、毎年の営業収支（減価償却前）を積み上げたもの。開業後 {params.evaluation.rampUp.length} 年間は需要が段階的に立ち上がる（
          {params.evaluation.rampUp.map((r) => `${Math.round(r * 100)}%`).join('→')}）。
        </p>
      </section>

      <section class="panel-section">
        <h2>建設費の内訳</h2>
        <table class="breakdown">
          <thead>
            <tr><th>構造</th><th>延長</th><th>駅</th><th>金額</th></tr>
          </thead>
          <tbody>
            {structRows.map((s) => {
              const b = c.byStructure[s];
              const sub = b.trackCost + b.stationCost + b.landCost;
              return (
                <tr key={s}>
                  <th>{STRUCTURE_LABELS[s]}</th>
                  <td>{b.lengthKm.toFixed(1)} km</td>
                  <td>{b.stationCount}</td>
                  <td>
                    <div class="amount">{oku(sub)}</div>
                    <Bar value={sub} max={maxPart} />
                    <div class="detail">線路 {oku(b.trackCost)} / 駅 {oku(b.stationCost)}{b.landCost > 0 ? ` / 用地 ${oku(b.landCost)}` : ''}</div>
                  </td>
                </tr>
              );
            })}
            <tr>
              <th>車両</th>
              <td colSpan={2}>{c.vehicles.trainsets} 編成 {c.vehicles.cars} 両</td>
              <td><div class="amount">{oku(c.vehicles.cost)}</div><Bar value={c.vehicles.cost} max={maxPart} /></td>
            </tr>
          </tbody>
          <tfoot>
            <tr><th>合計</th><td colSpan={2} /><td class="amount">{oku(c.total)}</td></tr>
          </tfoot>
        </table>
        {c.landPriceMissing && <p class="hint">※ 一部の区間で近くに地価公示地点がなく、用地費を 0 としています。</p>}
      </section>

      <section class="panel-section">
        <h2>年間運行経費の内訳</h2>
        <table class="breakdown">
          <tbody>
            {opexRows.map(([label, v]) => (
              <tr key={label}>
                <th>{label}</th>
                <td><div class="amount">{oku(v)}</div><Bar value={v} max={maxOpex} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="hint">
          運行: 片道 {params.service.trainsPerDayOneWay} 本/日・{params.service.carsPerTrain} 両編成（年間 {int(o.carKm / 1e4)} 万車両キロ）。運行本数は Phase 1 では固定。
        </p>
      </section>

      <section class="panel-section">
        <h2>駅別の乗降人員（日平均）</h2>
        <table class="station-table">
          <thead>
            <tr><th>駅</th><th>乗降</th><th>駅勢圏</th><th>乗換</th></tr>
          </thead>
          <tbody>
            {demand.stations.map((s) => {
              const v = line.vertices.find((x) => x.id === s.stationId);
              return (
                <tr key={s.stationId}>
                  <th>
                    <button
                      type="button"
                      class="link"
                      onClick={() => {
                        editorStore.set({ selectedVertexId: s.stationId });
                        if (v) focusOn(v.position);
                      }}
                    >
                      {nameOf.get(s.stationId)}
                    </button>
                  </th>
                  <td>
                    {int(s.ridership)}
                    <Bar value={s.ridership} max={maxRidership} />
                  </td>
                  <td>{int(s.fromCatchment)}</td>
                  <td>{int(s.fromTransfer)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p class="hint">
          内訳: 新線内 {people(demand.tripsByType.local)} / 既存線と乗継 {people(demand.tripsByType.toExisting)} / 既存線からの経路転換 {people(demand.tripsByType.through)}。
          輸送人キロ {int(demand.dailyPassengerKm)} 人キロ/日。
        </p>
      </section>

      <section class="panel-section">
        <p class="note">
          前提: 営業収支は減価償却費・諸税・支払利息を含まない。建設期間中の利子、更新投資、既存線の収支への影響は考慮していない。
          単価・運賃の根拠と「仮置き」の値は docs/design.md §6 と src/config/cost.ts を参照。需要推計の精度は docs/calibration.md を参照。
        </p>
      </section>
    </div>
  );
}
