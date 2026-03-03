import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

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
});

// Copy SVG icon next to the node
mkdirSync('dist/nodes/X402Bazaar', { recursive: true });
copyFileSync(
	'nodes/X402Bazaar/x402-bazaar.svg',
	'dist/nodes/X402Bazaar/x402-bazaar.svg',
);

console.log('✅ Build complete — zero runtime dependencies');
