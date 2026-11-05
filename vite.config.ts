import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

/*
 * report 静态壳 —— Vite 配置
 *
 * - root = src/ui，产物落仓库根 dist/（纯静态；空 base 用相对路径，任意静态宿主可托管）
 * - 壳内没有任何后端地址；数据在后端输入的 `ep` 里（design §11/§17）
 * - core 目录只作为类型/markdown 子集源码被引用，不产生第二个实现
 */
/**
 * file:// 兼容：ES module 在 file:// 下会被浏览器拦，而经典 <script src> 不会。
 * 构建产物因此打成单个 IIFE（assets/app.js），并在 build 后把 module script
 * 改写为经典 script——与 SSG 导出的自包含口径一致（design §14/§17）。
 */
function classicScriptPlugin(): {
  name: string;
  apply: "build";
  transformIndexHtml: (html: string) => string;
} {
  return {
    name: "report-classic-script",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/, '<script src="$1" defer></script>')
        .replace(/\scrossorigin(?=[\s>])/g, "");
    },
  };
}

export default defineConfig({
  root: "src/ui",
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss(), classicScriptPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/ui", import.meta.url)),
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: "iife",
        name: "ReportShell",
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
