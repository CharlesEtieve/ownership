// Bundles the action into a single file in dist/, as GitHub runs it without installing dependencies.
// See: https://rollupjs.org/introduction/
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

export default {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true
  },
  // Dependencies compiled from TypeScript use top-level `this` and have a harmless import cycle.
  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED' || warning.code === 'CIRCULAR_DEPENDENCY') return
    warn(warning)
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json', outDir: 'dist' }),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json()
  ]
}
