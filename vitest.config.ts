import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Real-process integration fixtures and Ink keyboard tests share host resources.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    },
  },
});
