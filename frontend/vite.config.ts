import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` in a browser talks to `go run ./cmd/devserver`.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:34116" } },
});
