import { Agent } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const logProxy: ProxyOptions["configure"] = (proxy) => {
  const at = () => new Date().toISOString();
  proxy.on("proxyReq", (_req, req) => console.log(`${at()} fwd  ${req.method} ${req.url}`));
  proxy.on("proxyRes", (res, req) => console.log(`${at()} back ${req.method} ${req.url} ${res.statusCode}`));
  proxy.on("error", (err, req) => console.log(`${at()} err  ${req.method} ${req.url} ${err.message}`));
};

export default defineConfig({
  plugins: [react()],
  build: {
    // Phaser alone is ~1.4 MB minified. It lives in its own chunk, loaded after login (see map/MapView.tsx),
    // so the limit is set just above it: the warning still fires if anything else grows that large.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5180,
    // Same-origin API calls in development (session cookies will rely on this from Phase 2). `ws` also forwards the
    // live connection (Socket.IO under /api/socket.io). `vite preview` uses the same proxy.
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 4100}`,
        ws: true,
        // Without an agent the proxy sends `Connection: close` both ways, so the browser opens a new connection for
        // every API call. The browser tests' container reaches this machine through Docker Desktop's forwarding, which
        // now and then loses a new connection; reusing connections keeps the tests from waiting on one.
        agent: new Agent({ keepAlive: true }),
        // LOG_REQUESTS=1 (the browser tests) logs each proxied request, to tell where a stalled request stopped.
        configure: process.env.LOG_REQUESTS === "1" ? logProxy : undefined,
      },
    },
  },
});
