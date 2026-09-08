import { resolve } from 'node:path';
import { build } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

/**
 * The music worklet, built into the library as text.
 *
 * An audio worklet can only be loaded from a URL, and this library is one file with nothing
 * beside it to point at, so the worklet is bundled on its own here and imported as a string;
 * the runtime makes a URL out of it at load. That keeps the promise the library makes: a page
 * imports one module and has everything.
 */
function musicWorklet(): Plugin {
  const id = 'virtual:music-worklet';
  const resolved = `\0${id}`;
  let entry = 'src/runtime/audio/worklet.ts';

  return {
    name: 'music-worklet',
    // The entry has to be named absolutely: the dev server puts every watched file through the
    // same resolver it puts imports through, and a relative path has nothing to resolve against
    // in a module that is not on disk.
    configResolved(config) {
      entry = resolve(config.root, 'src/runtime/audio/worklet.ts');
    },
    resolveId: (source) => (source === id ? resolved : null),
    async load(source) {
      if (source !== resolved) return null;
      const bundled = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        target: 'es2022',
        minify: true,
        write: false,
        logLevel: 'warning',
      });
      // Watched so that editing the worklet rebuilds it while the dev server is up.
      this.addWatchFile(entry);
      // One long string and nothing else; there is no source of its own to map back to.
      return { code: `export default ${JSON.stringify(bundled.outputFiles[0].text)};`, map: null };
    },
  };
}

export default defineConfig({
  server: { fs: { allow: ['..', '../..'] } },
  plugins: [musicWorklet()],
  build: {
    // Vite leaves the whitespace in an ES library build, so that whatever bundles it downstream
    // can still read the purity annotations. Nothing bundles this one (a page loads it as it
    // is), so `npm run minify` takes that whitespace out afterwards, which is a quarter off
    // what a player downloads.
    target: 'es2022',
    // public/ holds a game package for `npm run dev` to serve. That is a convenience of this
    // repository's, not part of the library, and it does not belong in what is published.
    copyPublicDir: false,
    // One precompiled ES module, Excalibur and all, so a page can import it with nothing to
    // resolve and no build step of its own. The packaging script writes such a page.
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'fusion-runtime.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
