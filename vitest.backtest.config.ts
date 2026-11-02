import { defineConfig } from 'vitest/config';

// バックテストの推計（scripts/backtest.py から呼ぶ）。通常の npm test には含めない
export default defineConfig({
  test: {
    include: ['tests/backtest/*.run.ts'],
    environment: 'node',
  },
});
