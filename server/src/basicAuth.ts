import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Gates the whole app behind a single shared username/password, like a classic
 * .htaccess prompt. Deliberately simple: this is a leadership dashboard shared
 * with a small internal audience, not a multi-user product needing per-account
 * login, roles, or sessions.
 */
export function registerBasicAuth(app: FastifyInstance, username: string, password: string): void {
  const expected = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/health") return; // let uptime/health checks through unauthenticated

    const header = req.headers.authorization;
    if (!header || !safeEqual(header, expected)) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="Piwik Trends Analyzer"')
        .send({ error: "Authentification requise" });
    }
  });
}
