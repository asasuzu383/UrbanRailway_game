import { defineConfig } from 'vitest/config';

// GitHub Pages ではリポジトリ名がサブパスになるため、CI では BASE_PATH を渡す
// （例: BASE_PATH=/UrbanRailway_game/）。ローカルでは '/'。
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
