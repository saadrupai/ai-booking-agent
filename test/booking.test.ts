import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, type Business } from "../src/scheduler.ts";
import { Agent } from "../src/agent.ts";
import { DemoLLM } from "../src/demo-llm.ts";
import { runTool } from "../src/tools.ts";
import { buildServer } from "../src/server.ts";
import type { LLM, Msg, LLMReply } from "../src/llm.ts";

const business: Business = JSON.parse(readFileSync(new URL("../config/business.json", import.meta.url), "utf8"));
// Fixed "now": Monday 2026-11-16 08:00 local (13:00 UTC)
const NOW = () => new Date("2026-11-16T13:00:00Z");
const fresh = (path?: string) => new Scheduler(business, path, NOW);

test("availability respects opening hours and service length", () => {
  const s = fresh();
  const thu = s.availability("2026-11-19", "whitening"); // Thu 09:00-19:00, 90 min
  assert.equal(thu[0], "09:00");
  assert.equal(thu.at(-1), "17:30");
  assert.deepEqual(s.availability("2026-11-21", "checkup"), [], "closed on Saturday");
});

test("no slots in the past or within 1 hour", () => {
  const s = fresh();
  const today = s.availability("2026-11-16", "consult"); // now is 08:00
  assert.ok(!today.includes("08:30"));
  assert.equal(today[0], "09:30", "09:00 is exactly 1h away, so the first bookable slot is 09:30");
});

test("booking removes overlapping slots and prevents double-booking", () => {
  const s = fresh();
  s.book({ serviceId: "checkup", date: "2026-11-17", time: "10:00", name: "Ann", email: "ann@x.co" });
  const free = s.availability("2026-11-17", "consult");
  assert.ok(!free.includes("10:00") && !free.includes("10:30"));
  assert.ok(free.includes("09:30") && free.includes("11:00"));
  assert.throws(() => s.book({ serviceId: "consult", date: "2026-11-17", time: "10:30", name: "Bob", email: "bob@x.co" }), /not available/);
});

test("cancel requires matching email and frees the slot", () => {
  const s = fresh();
  const b = s.book({ serviceId: "consult", date: "2026-11-17", time: "14:00", name: "Cy", email: "cy@x.co" });
  assert.throws(() => s.cancel(b.id, "attacker@x.co"), /not found/);
  s.cancel(b.id, "CY@x.co");
  assert.ok(s.availability("2026-11-17", "consult").includes("14:00"));
});

test("bookings persist to disk", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bk-")), "b.json");
  fresh(file).book({ serviceId: "consult", date: "2026-11-18", time: "11:00", name: "Di", email: "di@x.co" });
  assert.equal(fresh(file).list().length, 1);
});

test("tools return errors (not exceptions) so the model can recover", () => {
  const s = fresh();
  const r = runTool(s, "book_appointment", { service_id: "consult", date: "2026-11-21", time: "10:00", name: "E", email: "e@x.co" }) as { error: string };
  assert.match(r.error, /not available/);
  const bad = runTool(s, "check_availability", { date: "next week", service_id: "consult" }) as { error: string };
  assert.match(bad.error, /YYYY-MM-DD/);
});

test("agent loop executes tool calls and returns the final answer", async () => {
  // Scripted LLM: first asks for availability, then answers using the result.
  class Scripted implements LLM {
    name = "scripted";
    async chat(_s: string, messages: Msg[]): Promise<LLMReply> {
      const last = messages.at(-1)!;
      if (last.role === "user") return { text: "", toolCalls: [{ id: "t1", name: "check_availability", input: { date: "2026-11-17", service_id: "consult" } }] };
      const r = JSON.parse((last as { content: string }).content);
      return { text: `First free: ${r.free_times[0]}`, toolCalls: [] };
    }
  }
  const out = await new Agent(fresh(), new Scripted()).reply("s1", "any consult slots tuesday?");
  assert.equal(out.text, "First free: 09:00");
  assert.deepEqual(out.toolsUsed, ["check_availability"]);
});

test("agent stops after max steps if the model loops", async () => {
  class Looper implements LLM {
    name = "looper";
    async chat(): Promise<LLMReply> { return { text: "", toolCalls: [{ id: "x", name: "get_business_info", input: {} }] }; }
  }
  const out = await new Agent(fresh(), new Looper()).reply("s", "hi");
  assert.match(out.text, /stuck/);
});

test("end-to-end booking conversation in demo mode", async () => {
  const s = fresh();
  const agent = new Agent(s, new DemoLLM());
  let r = await agent.reply("c", "Do you have check-up slots on Thursday?");
  assert.match(r.text, /2026-11-19/);
  r = await agent.reply("c", "Book 2pm please, my name is Sara Khan, email sara@example.com");
  assert.match(r.text, /booked/i);
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].start, "2026-11-19T14:00:00-05:00");
  const id = /BK-[A-Z0-9]{6}/.exec(r.text)![0];
  r = await agent.reply("c", `Please cancel ${id}, email sara@example.com`);
  assert.match(r.text, /cancelled/);
  assert.equal(s.list().length, 0);
});

test("HTTP API: chat works and bookings endpoint needs admin key", async () => {
  process.env.ADMIN_KEY = "";
  const server = buildServer(fresh(), new DemoLLM()).listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://localhost:${port}/api/chat`, { method: "POST", body: JSON.stringify({ message: "how much is whitening?" }) });
    const d = await r.json();
    assert.match(d.reply, /Whitening/);
    assert.ok(d.sessionId);
    const b = await fetch(`http://localhost:${port}/api/bookings`);
    assert.equal(b.status, 401);
  } finally {
    server.close();
  }
});
