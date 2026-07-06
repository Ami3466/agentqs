/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Overridable so test builds (e.g. `npm run log:test`) can't collide with a
  // running `next dev` that owns .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // Native / heavy server-only deps must stay external (not webpack-bundled): the
  // local embedders (transformers.js + onnxruntime), image tooling (sharp, exifr),
  // and the sqlite-vec loadable extension all ship native binaries or resolve model
  // files at runtime.
  experimental: {
    serverComponentsExternalPackages: [
      "@huggingface/transformers",
      "onnxruntime-node",
      "sharp",
      "exifr",
      "better-sqlite3",
      "sqlite-vec",
    ],
  },
};

export default nextConfig;
