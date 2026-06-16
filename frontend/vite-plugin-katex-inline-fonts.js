/**
 * vite-plugin-katex-inline-fonts.js
 *
 * Post-build Vite plugin: reads the KaTeX CSS from node_modules, base64-encodes
 * every woff2 font file, rewrites url(fonts/...) references to
 * url(data:font/woff2;base64,...), then appends the result to the emitted
 * dist/assets/index.css so the avatar gateway (native.rs) can serve a
 * self-contained CSS file with no naked font paths.
 *
 * Uses writeBundle (which receives outputOptions) so it works correctly when
 * vite is invoked with a custom --outDir (e.g. from verify-dist.sh).
 *
 * Only woff2 entries are kept per @font-face (woff/ttf fallbacks stripped),
 * keeping the output as compact as possible while still satisfying all modern
 * browsers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function katexInlineFonts() {
  return {
    name: 'katex-inline-fonts',
    apply: 'build',
    // writeBundle receives (outputOptions, bundle) — outputOptions.dir is the
    // actual output directory even when --outDir overrides vite.config.js.
    writeBundle(outputOptions) {
      const katexDir = path.join(__dirname, 'node_modules', 'katex', 'dist');
      const katexCssPath = path.join(katexDir, 'katex.css');
      const fontsDir = path.join(katexDir, 'fonts');

      if (!fs.existsSync(katexCssPath)) {
        throw new Error('[katex-inline-fonts] katex.css not found at ' + katexCssPath);
      }

      // Resolve the output directory from writeBundle's outputOptions.
      // outputOptions.dir is the root output dir (e.g. dist/); assets live in dist/assets/.
      const outDir = outputOptions.dir
        ? path.resolve(outputOptions.dir)
        : path.join(__dirname, 'dist');

      // The CSS file is always at <outDir>/assets/index.css (assetFileNames rule in vite.config.js).
      const distCss = path.join(outDir, 'assets', 'index.css');

      if (!fs.existsSync(distCss)) {
        // No CSS emitted (e.g. SSR build) — skip silently.
        console.warn('[katex-inline-fonts] index.css not found at ' + distCss + ', skipping');
        return;
      }

      const existing = fs.readFileSync(distCss, 'utf8');
      // Guard against double-injection during incremental rebuilds.
      if (existing.includes('KaTeX_Main')) {
        console.log('[katex-inline-fonts] KaTeX fonts already present in index.css, skipping');
        return;
      }

      let css = fs.readFileSync(katexCssPath, 'utf8');

      // Replace each woff2 url with a base64 data: URI.
      css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (match, filename) => {
        const fontPath = path.join(fontsDir, filename);
        if (!fs.existsSync(fontPath)) {
          throw new Error('[katex-inline-fonts] font file not found: ' + fontPath);
        }
        const b64 = fs.readFileSync(fontPath).toString('base64');
        return `url(data:font/woff2;base64,${b64})`;
      });

      // Strip naked woff / ttf fallback entries from src: lists so no bare
      // fonts/ path survives. These come after the woff2 entry in every src: line.
      css = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("[^"]*"\)/gi, '');

      // Sanity: no naked fonts/ path should remain.
      if (/url\(\s*fonts\//.test(css)) {
        throw new Error('[katex-inline-fonts] BUG: naked fonts/ path survived inlining');
      }

      fs.writeFileSync(distCss, existing + '\n' + css, 'utf8');
      console.log('[katex-inline-fonts] KaTeX font CSS (woff2 base64) appended to ' + distCss);
    },
  };
}
