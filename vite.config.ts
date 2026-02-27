import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const configuredBase = env.VITE_BASE_PATH || "/";
  const base =
    configuredBase.charAt(configuredBase.length - 1) === "/"
      ? configuredBase
      : `${configuredBase}/`;
  const securityHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };

  return {
    base,
    plugins: [react()],
    server: {
      headers: securityHeaders,
    },
    preview: {
      headers: securityHeaders,
    },
  };
});
