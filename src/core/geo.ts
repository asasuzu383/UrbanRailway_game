import type { LngLat } from './types';

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** 2点間の大円距離 [km]（Haversine）。首都圏スケールでは誤差は無視できる。 */
export function distanceKm(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 折れ線の延長 [km]。 */
export function polylineLengthKm(points: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceKm(points[i - 1]!, points[i]!);
  }
  return total;
}
