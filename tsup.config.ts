import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Ship the patched text caches and production renderer in the npm artifact.
  // NODE_ENV in the caller's shell must not enable React's accumulating timings.
  noExternal: ['ink', 'react', 'react-reconciler', 'scheduler'],
  define: {'process.env.NODE_ENV': '"production"'},
  esbuildPlugins: [{
    name: 'omit-ink-devtools',
    setup(build) {
      // Ink's optional debugger is development-only; bundling it would eagerly
      // import react-devtools-core even when DEV is unset.
      build.onLoad({filter: /[/\\]ink[/\\]build[/\\]devtools\.js$/}, () => ({
        contents: 'export {};',
        loader: 'js',
      }));
    },
  }],
  banner: {
    js: '#!/usr/bin/env node\nimport {createRequire as createBundleRequire} from "node:module";\nconst require = createBundleRequire(import.meta.url);',
  },
});
