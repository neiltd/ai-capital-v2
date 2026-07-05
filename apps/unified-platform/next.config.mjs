/** @type {import('next').NextConfig} */
const config = {
  // Workspace packages authored as TS ESM (./foo.js imports resolving to ./foo.ts)
  // must be transpiled by Next.js for webpack to follow extension-rewriting.
  transpilePackages: ['@common/pipeline-runs', '@common/types', '@common/db'],

  // @common/db re-exports a LanceDB factory whose native .node binary webpack
  // can't bundle. Mark the lance bits external so they're loaded via require
  // at runtime on the server only. In Next 14.2 this lives under experimental;
  // when we upgrade to 15+ this can move to top-level `serverExternalPackages`.
  experimental: {
    serverComponentsExternalPackages: [
      '@lancedb/lancedb',
      '@lancedb/lancedb-darwin-arm64',
      'onnxruntime-node',
      '@huggingface/transformers',
      'pg',
    ],
  },

  webpack(cfg, { isServer }) {
    // maplibre-gl uses 'fs' module which doesn't exist in browser bundles
    cfg.resolve.fallback = { ...cfg.resolve.fallback, fs: false }

    // Workspace packages use TS-ESM convention: `from './foo.js'` resolves to ./foo.ts.
    // tsc/tsx handle this natively; webpack needs an explicit hint.
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    }

    // @napi-rs/canvas + better-sqlite3 use native .node binaries — must be external (server-only)
    if (isServer) {
      cfg.externals = [...(cfg.externals ?? []), '@napi-rs/canvas', 'better-sqlite3']
    }

    return cfg
  },
}
export default config
