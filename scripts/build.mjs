import { build } from 'esbuild'

const target = 'node22'

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target,
  sourcemap: false,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-easygit-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  sourcemap: false,
  logLevel: 'info',
})
