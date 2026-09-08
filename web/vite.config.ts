import { defineConfig } from 'vite';

export default defineConfig({
  server: { fs: { allow: ['..', '../..'] } },
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
