import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  optimizeDeps: {
    entries: ["index.html"],
    esbuildOptions: {
      define: { "WebGLRenderingContext.UNPACK_FLIP_Y_WEBGL": "37440" },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/cubism-core": {
        target: "https://cubism.live2d.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cubism-core/, ""),
      },
    },
  },
});
