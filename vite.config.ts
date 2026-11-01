import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// GitHub Pages ではリポジトリ名がサブパスになるため、CI では BASE_PATH を渡す
// （例: BASE_PATH=/UrbanRailway_game/）。ローカルでは '/'。
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [preact()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // バンドルした OSS（MapLibre・Chart.js・Preact など）の著作権表示・ライセンス全文を出力する。
    // MIT / BSD は再配布時にこの表示が必要。ドット始まりのファイルは Pages の成果物から除外されるため既定名は使わない。
    license: { fileName: 'third-party-licenses.md' },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
