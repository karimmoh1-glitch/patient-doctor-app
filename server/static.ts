import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // The web app answers page requests only. A non-page request (any other method, or anything under /api that no
  // route handled) is "not found", never the HTML page with a success status.
  app.use("*", (req, res) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.originalUrl.startsWith("/api")) {
      return res.status(404).json({ message: "Not found" });
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
