import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, ".", "");
    var configuredBase = env.VITE_BASE_PATH || "/";
    var base = configuredBase.charAt(configuredBase.length - 1) === "/"
        ? configuredBase
        : "".concat(configuredBase, "/");
    var securityHeaders = {
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    };
    return {
        base: base,
        plugins: [react()],
        server: {
            headers: securityHeaders,
        },
        preview: {
            headers: securityHeaders,
        },
    };
});
