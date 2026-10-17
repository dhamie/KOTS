import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const configureProxy: ProxyOptions["configure"] = (proxy) => {
  // The proxy opens a new connection to the API for each request and asks the API to close it after (`Connection:
  // close`). Dropping that header from the reply lets the browser keep its own connection to the proxy open. The
  // browser tests' container reaches this machine through Docker Desktop's forwarding, which now and then loses a
  // new connection, so the browser must not need one per request. (A keep-alive agent to the API instead would
  // reuse connections the API had just closed, and fail with 502s.)
  proxy.on("proxyRes", (res) => {
    delete res.headers.connection;
  });
  // LOG_REQUESTS=1 (the browser tests) logs each proxied request, to tell where a stalled request stopped.
  if (process.env.LOG_REQUESTS !== "1") return;
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
        configure: configureProxy,
      },
    },
  },
});
