/**
 * 運行体系パネル（Phase 2 M6。docs/design.md §14）: 種別の追加・削除、停車駅、時間帯別本数、編成両数、直通先。
 * 編集は scenarioStore.updatePlan で運行計画（シナリオの servicePlans）に保存する（元に戻す・やり直すの対象）。
 */
import { DEFAULT_TRANSIT_TYPE, TRANSIT_TYPES } from '../../config/transitTypes';
import { MAX_SERVICE_PATTERNS, type ServicePattern, type ServicePlan } from '../../core/types';
import { computeStore, scenarioStore, throughCandidates } from '../../state/appState';
import { int } from '../format';
import { useStore } from '../hooks';
import { Warnings } from './Warnings';

const QUALITY_LABEL: Record<string, string> = { timetable: '時刻表', published: '公表資料', provisional: '仮置き' };
const PATTERN_NAMES = ['各停', '快速', '急行'];

export function ServicePanel() {
  const { scenario } = useStore(scenarioStore.store);
  const compute = useStore(computeStore);
  const line = scenario.lines[0]!;
  const geo = compute.geometry;
  const plan = compute.plan;
  const op = compute.operation;
  const t = TRANSIT_TYPES[line.transitType ?? DEFAULT_TRANSIT_TYPE];

  if (!geo || !plan || geo.stations.length < 2) {
    return <section class="panel-section"><p class="hint">「路線」タブで駅を 2 つ以上置くと、運行体系を設定できます。</p></section>;
  }
  const stations = geo.stations;
  const update = (fn: (p: ServicePlan) => ServicePlan) => scenarioStore.updatePlan(fn, plan);
  const setPattern = (id: string, patch: Partial<ServicePattern>) =>
    update((p) => ({ ...p, patterns: p.patterns.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const isCustom = scenario.servicePlans.some((p) => p.lineId === line.id);

  const addPattern = () =>
    update((p) => {
      const base = p.patterns[0]!;
      const id = `p${Date.now().toString(36)}`;
      // 新しい種別は起終点と接続駅に停まる快速から始める
      const stops = stations.filter((s, i) => i === 0 || i === stations.length - 1 || s.transferTo).map((s) => s.id);
      const name = PATTERN_NAMES.find((n) => !p.patterns.some((x) => x.name === n)) ?? `種別${p.patterns.length + 1}`;
      return { ...p, patterns: [...p.patterns, { id, name, stopStationIds: stops, tphPeak: 4, tphOffpeak: 3, carsPerTrain: base.carsPerTrain }] };
    });

  const toggleStop = (pt: ServicePattern, stationId: string, on: boolean) => {
    const current = pt.stopStationIds ?? stations.map((s) => s.id);
    const set = new Set(current);
    if (on) set.add(stationId);
    else set.delete(stationId);
    const ids = stations.map((s) => s.id).filter((id) => set.has(id));
    setPattern(pt.id, { stopStationIds: ids.length === stations.length ? null : ids });
  };

  const ends = [stations[0]!, stations[stations.length - 1]!].filter((s) => s.transferTo);
  const throughAt = (stationId: string) => plan.through.find((x) => x.atStationId === stationId)?.routeId ?? '';
  const setThrough = (stationId: string, routeId: string) =>
    update((p) => ({
      ...p,
      through: [...p.through.filter((x) => x.atStationId !== stationId), ...(routeId ? [{ atStationId: stationId, routeId }] : [])],
    }));

  return (
    <div class="service">
      <section class="panel-section">
        <h2>運行体系（{t.name}）</h2>
        <p class="hint">
          最高速度 {t.maxSpeedKmh} km/h・1 両の定員 {t.capacityPerCar} 人・最小運転間隔 {t.minHeadwayMin} 分・最大 {t.maxCarsPerTrain} 両。
          所要時間は駅間距離と停車駅から計算します（{isCustom ? '設定した計画' : '既定の計画'}）。
        </p>
        <Warnings items={compute.warnings} />

        {plan.patterns.map((pt, k) => {
          const po = op?.patterns[k];
          const stopSet = new Set(pt.stopStationIds ?? stations.map((s) => s.id));
          return (
            <div key={pt.id} class="pattern-card">
              <div class="pattern-head">
                <input type="text" value={pt.name} aria-label="種別名" onChange={(e) => e.currentTarget.value.trim() && setPattern(pt.id, { name: e.currentTarget.value.trim() })} />
                <label>
                  <input type="checkbox" checked={pt.stopStationIds === null} onChange={(e) => setPattern(pt.id, { stopStationIds: e.currentTarget.checked ? null : stations.map((s) => s.id) })} />
                  全駅停車
                </label>
                {plan.patterns.length > 1 && (
                  <button type="button" aria-label={`${pt.name}を削除`} onClick={() => update((p) => ({ ...p, patterns: p.patterns.filter((x) => x.id !== pt.id) }))}>削除</button>
                )}
              </div>
              <div class="pattern-nums">
                <label>ピーク（本/時）<input type="number" min={0} step={1} value={pt.tphPeak} onChange={(e) => setPattern(pt.id, { tphPeak: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
                <label>日中（本/時）<input type="number" min={0} step={1} value={pt.tphOffpeak} onChange={(e) => setPattern(pt.id, { tphOffpeak: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
                <label>編成両数<input type="number" min={1} max={t.maxCarsPerTrain} step={1} value={pt.carsPerTrain} onChange={(e) => setPattern(pt.id, { carsPerTrain: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) })} /></label>
              </div>
              {pt.stopStationIds !== null && (
                <div class="stop-list" role="group" aria-label={`${pt.name}の停車駅`}>
                  {stations.map((s, i) => {
                    const end = i === 0 || i === stations.length - 1;
                    return (
                      <label key={s.id}>
                        <input type="checkbox" checked={stopSet.has(s.id) || end} disabled={end} onChange={(e) => toggleStop(pt, s.id, e.currentTarget.checked)} />
                        {s.name}
                      </label>
                    );
                  })}
                </div>
              )}
              {po && (
                <p class="pattern-meta">
                  {stations[0]!.name}〜{stations[stations.length - 1]!.name} {po.oneWayMin.toFixed(0)} 分
                  （表定速度 {(geo.totalKm / (po.oneWayMin / 60)).toFixed(0)} km/h）・停車 {po.stops.filter(Boolean).length} 駅・必要 {po.trainsets} 編成
                </p>
              )}
            </div>
          );
        })}

        <div class="button-row">
          <button type="button" disabled={plan.patterns.length >= MAX_SERVICE_PATTERNS} onClick={addPattern}>種別を追加</button>
          <button type="button" disabled={!isCustom} onClick={() => scenarioStore.resetPlan()}>既定の計画に戻す</button>
        </div>
      </section>

      <section class="panel-section">
        <h2>直通運転</h2>
        {ends.length === 0 ? (
          <p class="hint">起点か終点を既存駅に接続すると、既存の路線への直通を設定できます。</p>
        ) : (
          ends.map((s) => {
            const cands = throughCandidates(s.transferTo);
            return (
              <div key={s.id} class="field-row">
                <span>{s.name}から</span>
                <select aria-label={`${s.name}からの直通先`} value={throughAt(s.id)} onChange={(e) => setThrough(s.id, e.currentTarget.value)}>
                  <option value="">直通しない</option>
                  {cands.map((c) => (
                    <option key={c.id} value={c.id}>{c.operator} {c.name}（{QUALITY_LABEL[c.quality] ?? c.quality}）</option>
                  ))}
                </select>
              </div>
            );
          })
        )}
        <p class="hint">直通先の駅へは乗換・待ちなしで行けるものとして需要を推計します。直通先を走る区間の車両・経費は数えません。</p>
      </section>

      {op && op.passingStations.length > 0 && (
        <section class="panel-section">
          <h2>待避設備</h2>
          <p>
            通過運転のため、{op.passingStations.map((i) => stations[i]!.name).join('、')} に待避設備が必要です（建設費に加算）。
          </p>
        </section>
      )}
      <section class="panel-section">
        <p class="hint">年間 {int(op ? op.carKmPerYear / 1e4 : 0)} 万車両キロ・必要 {op?.trainsets ?? 0} 編成（予備込み {op?.cars ?? 0} 両）。</p>
      </section>
    </div>
  );
}
