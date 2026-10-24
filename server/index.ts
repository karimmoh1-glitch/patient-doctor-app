import "dotenv/config";
import { createApiApp, log } from "./app";
import { serveStatic } from "./static";

export { log };

(async () => {
  const { app, httpServer } = await createApiApp();

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);

    const fspath = await import("path");
    const fsmod = await import("fs");
    const { nanoid } = await import("nanoid");

    // Fallback for root and other non-API routes that Vite might miss in
    // some Express versions.
    app.get("*", async (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/@") || req.path.includes(".")) {
        return next();
      }
      try {
        const clientTemplate = fspath.resolve(import.meta.dirname, "..", "client", "index.html");
        let template = await fsmod.promises.readFile(clientTemplate, "utf-8");
        template = template.replace(
          `<head>`,
          `<head><script type="module">
import RefreshRuntime from "/@react-refresh"
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`
        );
        template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  const port = parseInt(process.env.PORT || "3001", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
