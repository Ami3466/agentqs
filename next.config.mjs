/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Overridable so test builds (e.g. `npm run log:test`) can't collide with a
  // running `next dev` that owns .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // The Data tab is now Pipeline; keep old bookmarks working.
  redirects: async () => [{ source: "/data", destination: "/pipeline", permanent: false }],
  // Native / heavy server-only deps must stay external (not webpack-bundled): the
  // local embedders (transformers.js + onnxruntime), image tooling (sharp, exifr),
  // the sqlite-vec loadable extension, and unpdf (a pdf.js build that resolves its
  // own font/cmap data from disk) all ship native binaries or resolve model files
  // at runtime.
  experimental: {
    // Boots the standalone ingest listener (src/instrumentation.ts) once per
    // server process.
    instrumentationHook: true,
    serverComponentsExternalPackages: [
      "@huggingface/transformers",
      "onnxruntime-node",
      "sharp",
      "exifr",
      "better-sqlite3",
      "sqlite-vec",
      "unpdf",
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // The data store (AGENTQS_DATA_DIR) defaults to ./data INSIDE the project,
      // so without this every imported event retriggers a dev recompile — which
      // briefly 404s the very API routes the importers are posting to.
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ["**/node_modules/**", "**/.git/**", "**/data/**", "**/tmp/**", "**/public/downloads/**"],
      };
    }
    return config;
  },
};

export default nextConfig;
