import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "decode-named-character-reference": resolve(import.meta.dirname, "node_modules/decode-named-character-reference/index.js")
    }
  },
  build: {
    rollupOptions: {
      input: {
        converter: resolve(import.meta.dirname, "index.html"),
        guide: resolve(import.meta.dirname, "discord-markdown-guide/index.html"),
        notFound: resolve(import.meta.dirname, "404.html")
      }
    }
  }
});
