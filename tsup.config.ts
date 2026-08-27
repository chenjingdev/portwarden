import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
