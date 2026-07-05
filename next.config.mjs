/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Keep native / self-loading packages out of the webpack server bundle so they run
  // from node_modules at runtime. Critical for sqlite-vec (it require.resolve()s its
  // platform .dylib — webpack would mangle that path and drop us to the js-cosine
  // fallback) and for the local embedding runtime (onnxruntime native binaries).
  experimental: {
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "sqlite-vec",
      "@xenova/transformers",
      "onnxruntime-node",
      "sharp",
    ],
  },
};

export default nextConfig;
