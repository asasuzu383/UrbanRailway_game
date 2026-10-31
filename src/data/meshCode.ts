/**
 * 地域メッシュコード（JIS X 0410）と緯度経度の相互変換。
 * 加工済みデータはメッシュコードだけを持ち、形状はブラウザ側で復元する（容量削減のため）。
 *
 * 1次メッシュ(4桁): 緯度 40分 × 経度 1度
 * 2次メッシュ(6桁): 1次を 8×8 分割（緯度 5分 × 経度 7分30秒）
 * 3次メッシュ(8桁): 2次を 10×10 分割（緯度 30秒 × 経度 45秒, 約1km）
 * 2分の1メッシュ(9桁): 3次を 2×2 分割（約500m）。末尾 1=南西, 2=南東, 3=北西, 4=北東
 */

export interface MeshBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export function meshBounds(code: string): MeshBounds {
  if (!/^\d{4}(\d{2}(\d{2}[1-4]?)?)?$/.test(code)) {
    throw new Error(`不正なメッシュコード: ${code}`);
  }
  const p = Number(code.slice(0, 2));
  const u = Number(code.slice(2, 4));
  let south = p / 1.5;
  let west = u + 100;
  let dLat = 2 / 3;
  let dLng = 1;

  if (code.length >= 6) {
    dLat /= 8;
    dLng /= 8;
    south += Number(code[4]) * dLat;
    west += Number(code[5]) * dLng;
  }
  if (code.length >= 8) {
    dLat /= 10;
    dLng /= 10;
    south += Number(code[6]) * dLat;
    west += Number(code[7]) * dLng;
  }
  if (code.length === 9) {
    dLat /= 2;
    dLng /= 2;
    const q = Number(code[8]) - 1;
    south += Math.floor(q / 2) * dLat;
    west += (q % 2) * dLng;
  }
  return { south, west, north: south + dLat, east: west + dLng };
}

export function meshCentroid(code: string): [number, number] {
  const b = meshBounds(code);
  return [(b.west + b.east) / 2, (b.south + b.north) / 2];
}

/** 緯度経度を含む 2分の1地域メッシュ（500m）のコードを返す。 */
export function halfMeshCodeAt(lng: number, lat: number): string {
  const latMin = lat * 60;
  const p = Math.floor(latMin / 40);
  const u = Math.floor(lng) - 100;
  const latRem1 = latMin - p * 40;
  const lngRem1 = (lng - Math.floor(lng)) * 60;
  const q = Math.floor(latRem1 / 5);
  const v = Math.floor(lngRem1 / 7.5);
  const latRem2 = (latRem1 - q * 5) * 60;
  const lngRem2 = (lngRem1 - v * 7.5) * 60;
  const r = Math.floor(latRem2 / 30);
  const w = Math.floor(lngRem2 / 45);
  const latRem3 = latRem2 - r * 30;
  const lngRem3 = lngRem2 - w * 45;
  const s = (latRem3 >= 15 ? 2 : 0) + (lngRem3 >= 22.5 ? 1 : 0) + 1;
  return `${p}${String(u).padStart(2, '0')}${q}${v}${r}${w}${s}`;
}
