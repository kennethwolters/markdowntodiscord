import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
