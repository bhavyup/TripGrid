import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tripgridDevApiFallback } from "./dev-api-fallback";

export default defineConfig({
  plugins: [react(), tripgridDevApiFallback()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
    // The repo often sits on the Windows drive (WSL /mnt),
    // where native file-change events are unreliable — poll.
    watch: {
      usePolling: true,
    },
  },
});
