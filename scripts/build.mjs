import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.resolve(process.env.HLS_SOURCE_DIR || path.join(root, '..', 'hls.js'));
const outputDir = path.join(root, 'public', 'vendor');
const sourcePackage = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8'));
const sourceRepository = 'https://github.com/video-dev/hls.js';
let revision = 'local';
let version = sourcePackage.version;
try {
  revision = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  version ||= execFileSync('git', ['-C', sourceDir, 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim().replace(/^v/, '');
} catch { version ||= 'local'; }

// Match the full-feature build switches in hls.js/build-config.js.
const features = ['SUBTITLES', 'ALT_AUDIO', 'EME_DRM', 'CMCD', 'CONTENT_STEERING',
  'VARIABLE_SUBSTITUTION', 'M2TS_ADVANCED_CODECS', 'MEDIA_CAPABILITIES', 'INTERSTITIALS', 'IFRAMES'];
const define = Object.fromEntries(features.map(name => [`__USE_${name}__`, 'true']));
define.__VERSION__ = JSON.stringify(version);
await mkdir(outputDir, { recursive: true });
const bundle = await build({
  absWorkingDir: root,
  entryPoints: [path.join(sourceDir, 'src', 'exports-default.ts')],
  bundle: true,
  outfile: path.join(outputDir, 'hls.js'),
  format: 'iife',
  globalName: 'HlsBundle',
  platform: 'browser',
  target: ['chrome100', 'safari15'],
  minify: true,
  legalComments: 'eof',
  metafile: true,
  define,
  nodePaths: [path.join(root, 'node_modules')],
  // The wrapper lets the upstream inject-worker module serialize the complete
  // bundle into its own Blob worker, as the official UMD build does.
  banner: { js: `/* hls.js ${version} built from local source. Apache-2.0; see hls.LICENSE, Apache-2.0.LICENSE, and licenses/. */\n(function __HLS_WORKER_BUNDLE__(__IN_WORKER__){` },
  footer: { js: 'if (!__IN_WORKER__) globalThis.Hls = HlsBundle.default;\n})(false);' },
});
await cp(path.join(sourceDir, 'LICENSE'), path.join(outputDir, 'hls.LICENSE'));
await writeFile(path.join(outputDir, 'hls-source.json'), `${JSON.stringify({ sourceDir: path.relative(root, sourceDir).split(path.sep).join('/'), sourceRepository, version, revision, features: 'full', builder: 'esbuild', bundledAt: new Date().toISOString() }, null, 2)}\n`);

// esbuild's legal comments do not retain package-level license/NOTICE files.
// Use its actual input graph so transitive packages keep their own notices too.
const bundledNames = new Set();
for (const input of Object.keys(bundle.metafile.inputs)) {
  const pieces = path.resolve(root, input).split(`${path.sep}node_modules${path.sep}`);
  if (pieces.length < 2) continue;
  const packageParts = pieces.at(-1).split(path.sep);
  bundledNames.add(packageParts[0].startsWith('@') ? packageParts.slice(0, 2).join('/') : packageParts[0]);
}
const bundledDependencies = [];
for (const name of [...bundledNames].sort()) {
  const packageDir = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const notices = (await readdir(packageDir)).filter(file => /^(LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/i.test(file)).sort();
  if (!notices.some(file => /^(LICENSE|LICENCE|COPYING)/i.test(file))) throw new Error(`Bundled dependency ${name} has no license file`);
  const destination = path.join(outputDir, 'licenses', name);
  await mkdir(destination, { recursive: true });
  for (const file of notices) await cp(path.join(packageDir, file), path.join(destination, file));
  bundledDependencies.push({ name, version: manifest.version, license: manifest.license, notices });
}
// url-toolkit ships the complete Apache 2.0 text, including its attribution.
// Retain it verbatim as the full license referenced by the hls.js notice.
await cp(path.join(root, 'node_modules', 'url-toolkit', 'LICENSE'), path.join(outputDir, 'Apache-2.0.LICENSE'));

const fontRoot = path.join(root, 'node_modules', '@fontsource', 'geist');
const fonts = await readdir(path.join(fontRoot, 'files'));
const fontFile = fonts.find(name => name === 'geist-latin-400-normal.woff2');
if (!fontFile) throw new Error('Geist latin font was not installed');
await cp(path.join(fontRoot, 'files', fontFile), path.join(outputDir, 'geist-latin.woff2'));
await cp(path.join(fontRoot, 'files', 'geist-latin-600-normal.woff2'), path.join(outputDir, 'geist-latin-semibold.woff2'));
await cp(path.join(fontRoot, 'LICENSE'), path.join(outputDir, 'geist.LICENSE'));

const iconRoot = path.join(root, 'node_modules', '@phosphor-icons', 'core');
const iconsDir = path.join(outputDir, 'icons');
await mkdir(iconsDir, { recursive: true });
// Keep only the icons used by the workbench instead of copying the full library.
const icons = ['download-simple', 'download', 'folder-simple', 'folder-open', 'plus', 'play', 'pause',
  'arrows-clockwise', 'arrow-clockwise', 'x', 'check', 'check-circle', 'warning-circle',
  'gear-six', 'list', 'link', 'dots-three', 'trash', 'magnifying-glass', 'arrow-up-right',
  'arrow-down', 'arrow-right', 'caret-down', 'film-strip', 'video', 'hard-drive', 'lightning',
  'clock', 'sliders-horizontal', 'number-square-one', 'pencil-simple', 'upload-simple',
  'clipboard-text', 'question', 'terminal-window', 'check-square', 'square', 'info', 'house',
  'file-video', 'stop', 'copy', 'sun', 'moon', 'list-checks', 'arrow-square-out', 'funnel',
  'cloud-arrow-down', 'rocket-launch', 'number-circle-one', 'keyboard', 'squares-four',
  'hard-drives', 'stack', 'gauge', 'list-bullets', 'export', 'broom', 'shield-check'];
for (const name of icons) {
  const from = path.join(iconRoot, 'assets', 'regular', `${name}.svg`);
  try { await cp(from, path.join(iconsDir, `${name}.svg`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await cp(path.join(iconRoot, 'LICENSE'), path.join(outputDir, 'phosphor.LICENSE'));
const fontPackage = JSON.parse(await readFile(path.join(fontRoot, 'package.json'), 'utf8'));
const iconPackage = JSON.parse(await readFile(path.join(iconRoot, 'package.json'), 'utf8'));
const dependencyRows = bundledDependencies.map(dependency => `| ${dependency.name} | ${dependency.version} | ${dependency.license} | ${dependency.notices.map(file => `[${file}](public/vendor/licenses/${dependency.name}/${file})`).join(', ')} |`).join('\n');
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nThis file records third-party components redistributed with StreamSave. Their original licenses and notices remain applicable to their respective files. This document does not select a license for StreamSave's own source code.\n\n## hls.js playback bundle\n\nThe prebuilt \`public/vendor/hls.js\` is built from [hls.js](${sourceRepository}), version \`${version}\`, revision \`${revision}\`. The source revision is available [upstream](${sourceRepository}/tree/${revision}). Build provenance is recorded in [hls-source.json](public/vendor/hls-source.json).\n\nThe upstream copyright and derivative-work notice is preserved in [hls.LICENSE](public/vendor/hls.LICENSE). The complete Apache License 2.0 text is included in [Apache-2.0.LICENSE](public/vendor/Apache-2.0.LICENSE), copied verbatim from url-toolkit's license file with its attribution retained. The bundle wrapper and build configuration are maintained in \`scripts/build.mjs\`.\n\nThe following dependencies are included in the actual esbuild input graph, including transitive packages. Their original license and any NOTICE files are copied during every build:\n\n| Component | Version | License | Original files |\n| --- | --- | --- | --- |\n${dependencyRows}\n\n## Font and icons\n\n| Component | Package version | License | Original file |\n| --- | --- | --- | --- |\n| [Geist](https://github.com/vercel/geist-font), distributed by @fontsource/geist | ${fontPackage.version} | SIL Open Font License 1.1 | [geist.LICENSE](public/vendor/geist.LICENSE) |\n| [Phosphor Icons](https://github.com/phosphor-icons/core) | ${iconPackage.version} | MIT | [phosphor.LICENSE](public/vendor/phosphor.LICENSE) |\n\n## External runtime\n\nStreamSave invokes an independently installed FFmpeg/ffprobe executable. These executables are not bundled in this repository; their licenses depend on the installed FFmpeg build.\n`);
console.log(`Built local hls.js ${version} (${revision.slice(0, 12)})`);
console.log(`Copied ${bundledDependencies.length} bundled dependency license sets, Geist font and Phosphor icons to public/vendor.`);
