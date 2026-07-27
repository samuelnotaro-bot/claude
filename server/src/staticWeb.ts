import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves the built web dashboard (web/dist) as static files, with an SPA fallback to
 * index.html for any unmatched GET route. Written by hand instead of depending on
 * @fastify/static: every release of that plugin compatible with our Fastify v4 stack
 * is affected by unpatched path-traversal / route-guard-bypass advisories
 * (GHSA-8pvw-jcv7-9cmj, GHSA-83w8-p2f5-377r) -- a fix only exists in the v10 line,
 * which requires Fastify v5. Our actual need here -- serve a handful of known build
 * output files -- doesn't justify carrying that risk.
 */
export function registerStaticWeb(app: FastifyInstance, root: string): void {
  const resolvedRoot = path.resolve(root);

  app.setNotFoundHandler((req, reply) => {
    if (req.raw.method !== "GET" && req.raw.method !== "HEAD") {
      return reply.code(404).send({ error: "Not found" });
    }
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }

    const requestedPath = decodeURIComponent(req.url.split("?")[0] ?? "/");
    const candidate = path.resolve(resolvedRoot, "." + requestedPath);
    const isWithinRoot = candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);

    const target =
      isWithinRoot && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : path.join(resolvedRoot, "index.html");

    const ext = path.extname(target);
    reply.type(MIME_TYPES[ext] ?? "application/octet-stream");
    return reply.send(fs.createReadStream(target));
  });
}
