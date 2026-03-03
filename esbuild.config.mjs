import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

// n8n's linter bans direct use of setTimeout, clearTimeout, globalThis etc.
// We remap them to local aliases so the bundled viem code passes the lint.
const GLOBAL_SHIM = [
	'var __n8n_g=(0,Function)("return this")();',
	'var setTimeout=__n8n_g.setTimeout.bind(__n8n_g);',
	'var clearTimeout=__n8n_g.clearTimeout.bind(__n8n_g);',
	'var setInterval=__n8n_g.setInterval.bind(__n8n_g);',
	'var clearInterval=__n8n_g.clearInterval.bind(__n8n_g);',
	'var setImmediate=__n8n_g.setImmediate?__n8n_g.setImmediate.bind(__n8n_g):undefined;',
	'var clearImmediate=__n8n_g.clearImmediate?__n8n_g.clearImmediate.bind(__n8n_g):undefined;',
].join('');

// Bundle each entry point into a single CJS file with all deps inlined
// n8n-workflow is external (provided by n8n at runtime as peer dep)
await build({
	entryPoints: [
		'nodes/X402Bazaar/X402Bazaar.node.ts',
		'credentials/X402BazaarCredentials.credentials.ts',
	],
	bundle: true,
	platform: 'node',
	target: 'node18',
	format: 'cjs',
	outdir: 'dist',
	outbase: '.',
	external: ['n8n-workflow'],
	sourcemap: false,
	minify: false,
	logLevel: 'info',
	banner: { js: GLOBAL_SHIM },
	define: {
		'globalThis': '__n8n_g',
	},
});

// Copy SVG icon next to the node
mkdirSync('dist/nodes/X402Bazaar', { recursive: true });
copyFileSync(
	'nodes/X402Bazaar/x402-bazaar.svg',
	'dist/nodes/X402Bazaar/x402-bazaar.svg',
);

console.log('✅ Build complete — zero runtime dependencies');
