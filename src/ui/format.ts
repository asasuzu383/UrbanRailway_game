/** 表示用の数値の書式 */

/** 円 → 「1,234 億円」（10億円未満は小数 1 桁） */
export function oku(yen: number): string {
  const v = yen / 1e8;
  const digits = Math.abs(v) >= 10 ? 0 : 1;
  return `${v.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: digits })} 億円`;
}

export function people(n: number): string {
  return `${Math.round(n).toLocaleString('ja-JP')} 人`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('ja-JP');
}

export function years(y: number | null): string {
  return y === null ? '回収不能' : `${y.toFixed(1)} 年`;
}
