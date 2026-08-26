/**
 * Browser-half bundle.
 *
 * The harness serves a plugin's browser code as a *lazy CJS factory*: executing
 * the script only registers a factory with `window.__ModuleLoader__`, and every
 * module side effect runs later, when the loader materializes it. The preset
 * that emits this shape lives inside the harness repository and is not
 * published, so the contract is restated here.
 *
 * Two parts carry all the risk:
 *
 * - the banner/intro/footer triple, whose `id` MUST equal this package's name.
 *   The loader throws if the script it fetched registered some other id.
 * - the externals list. Those specifiers are answered from the shell's shared
 *   module table at runtime; anything else must be inlined. Bundling one of
 *   them ships a second React or a second cordis identity into the page, and
 *   requiring one that is not on the list throws at materialization. There is
 *   no build-time gate for either mistake outside the harness repository.
 */
import { defineConfig } from 'tsdown'

/** Package name, and therefore the module id the loader registers. */
const ID = 'dsh-code-graph'

/**
 * Specifiers the shell shares with every plugin bundle.
 *
 * Mirrors `PLATFORM_MODULES` + `PRELOADED_CLIENT_EXTERNALS` in the harness
 * (`packages/client/web/src/platform.ts`). Matching is exact — the loader keys
 * its table by the specifier as written.
 */
const SHARED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const mode = process.env['NODE_ENV'] ?? 'production'

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // The host tsconfig excludes this tree and knows nothing about JSX; without
  // this the bundler would transform .tsx files under the wrong settings.
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  // Declarations come from `tsc -p tsconfig.client.json`; emitting them here
  // would wrap the banner and footer into the .d.ts and break parsing.
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => SHARED.has(specifier),
    alwaysBundle: (specifier: string) => !SHARED.has(specifier),
  },
  // A CJS artifact carries no `import.meta`, and browser builds of common
  // libraries probe both of these; leaving them undefined throws at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
