// Zero-dependency HTTP server: chat API, admin bookings API, static demo page.
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Scheduler, type Business } from "./scheduler.ts";
import { Agent } from "./agent.ts";
import { AnthropicLLM, OpenAILLM, type LLM } from "./llm.ts";
import { DemoLLM } from "./demo-llm.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";

export function pickLLM(env = process.env): LLM {
  if (env.ANTHROPIC_API_KEY) return new AnthropicLLM(env.ANTHROPIC_API_KEY, env.LLM_MODEL || undefined);
  if (env.OPENAI_API_KEY) return new OpenAILLM(env.OPENAI_API_KEY, env.LLM_MODEL || undefined, env.OPENAI_BASE_URL || undefined);
  return new DemoLLM();
}

export function buildServer(scheduler: Scheduler, llm: LLM) {
  const agent = new Agent(scheduler, llm);
  const hits = new Map<string, { n: number; t: number }>(); // naive per-IP rate limit

  return createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "access-control-allow-origin": process.env.ALLOWED_ORIGIN ?? "*",
                            "access-control-allow-headers": "content-type, x-admin-key" });
      res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "OPTIONS") return send(204, "");

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const ip = req.socket.remoteAddress ?? "?";
        const h = hits.get(ip) ?? { n: 0, t: Date.now() };
        if (Date.now() - h.t > 60_000) { h.n = 0; h.t = Date.now(); }
        if (++h.n > 30) return send(429, { error: "too many messages, slow down" });
        hits.set(ip, h);

        const body = await readJson(req);
        const message = String(body.message ?? "").trim();
        if (!message) return send(400, { error: "message is required" });
        const sessionId = String(body.sessionId || randomUUID());
        const r = await agent.reply(sessionId, message);
        return send(200, { sessionId, reply: r.text, toolsUsed: r.toolsUsed });
      }

      if (req.method === "GET" && url.pathname === "/api/bookings") {
        const key = String(req.headers["x-admin-key"] ?? "");
        if (!ADMIN_KEY || key.length !== ADMIN_KEY.length || !timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) {
          return send(401, { error: "admin key required" });
        }
        return send(200, { bookings: scheduler.list() });
      }

      if (req.method === "GET" && url.pathname === "/api/health") return send(200, { ok: true, llm: llm.name });

      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const file = normalize(join(ROOT, "web", rel));
        if (!file.startsWith(join(ROOT, "web")) || !existsSync(file)) return send(404, { error: "not found" });
        const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
        return send(200, readFileSync(file), types[extname(file)] ?? "application/octet-stream");
      }
      send(404, { error: "not found" });
    } catch (e) {
      console.error(e);
      send(500, { error: "internal error" });
    }
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const business: Business = JSON.parse(readFileSync(join(ROOT, process.env.BUSINESS_CONFIG ?? "config/business.json"), "utf8"));
  const scheduler = new Scheduler(business, process.env.BOOKINGS_FILE ?? join(ROOT, "bookings.json"));
  const llm = pickLLM();
  buildServer(scheduler, llm).listen(PORT, () => console.log(`AI booking agent on http://localhost:${PORT} (llm: ${llm.name})`));
}
