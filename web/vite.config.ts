import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
