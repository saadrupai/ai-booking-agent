// Offline DEMO mode — a small rule-based stand-in for an LLM so the project runs
// with no API key. It speaks the same tool-calling protocol as the real providers,
// which also makes it handy for end-to-end tests. Real deployments use Claude/OpenAI.
import type { LLM, LLMReply, Msg } from "./llm.ts";

const SERVICE_WORDS: Record<string, string> = {
  checkup: "checkup", "check-up": "checkup", cleaning: "checkup", whitening: "whitening",
  consult: "consult", consultation: "consult", emergency: "emergency",
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export class DemoLLM implements LLM {
  name = "demo (rule-based, no AI)";
  private n = 0;

  async chat(system: string, messages: Msg[]): Promise<LLMReply> {
    const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? new Date().toISOString().slice(0, 10);
    const last = messages[messages.length - 1];
    if (last.role === "tool") return { text: this.describe(last.name, JSON.parse(last.content), messages), toolCalls: [] };

    const text = last.role === "user" ? last.content.toLowerCase() : "";
    const ctx = messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content.toLowerCase()).join(" \n ");
    const call = (name: string, input: Record<string, string>): LLMReply => ({ text: "", toolCalls: [{ id: `demo_${++this.n}`, name, input }] });

    const cancel = /(bk-[a-z0-9]{6})/i.exec(text);
    const email = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(text)?.[0];
    if (/cancel/.test(text) && cancel && email) return call("cancel_appointment", { booking_id: cancel[1].toUpperCase(), email });

    const service = this.lastMatch(ctx, Object.keys(SERVICE_WORDS));
    const date = this.lastDate(ctx, today);
    const time = this.parseTime(text);
    const name = /(?:my name is|i am|i'm|name:)\s+([a-z][a-z .'-]{1,40}?)(?:[,.]|\s+and|\s+email|$)/i.exec(last.role === "user" ? last.content : "")?.[1];

    if (/book|reserve|schedule|confirm/.test(text) && service && date && time && name && email) {
      return call("book_appointment", { service_id: SERVICE_WORDS[service], date, time, name: name.trim(), email });
    }
    if (/avail|free|slot|open.*(on|tomorrow|today)|when can|book|appointment/.test(text)) {
      if (!service) return { text: "Happy to help you book! Which service would you like: check-up & cleaning, whitening, a free consultation, or an emergency visit?", toolCalls: [] };
      if (!date) return { text: "Sure. Which day works for you? (e.g. tomorrow, Thursday, or 2026-11-20)", toolCalls: [] };
      if (time && (!name || !email)) return { text: `Great, ${time} it is. To confirm the booking, please tell me your full name and email.`, toolCalls: [] };
      return call("check_availability", { date, service_id: SERVICE_WORDS[service] });
    }
    if (time && service && date && (!name || !email)) return { text: "Perfect. Please share your full name and email so I can confirm.", toolCalls: [] };
    return call("get_business_info", {});
  }

  private describe(tool: string, r: any, messages: Msg[]): string {
    if (r.error) return `Hmm, ${r.error} Could you pick another option?`;
    if (tool === "check_availability") {
      if (!r.free_times.length) return `Sorry, we're fully booked or closed on ${r.date}. Would another day work?`;
      return `On ${r.date} I have these times free: ${r.free_times.slice(0, 6).join(", ")}${r.free_times.length > 6 ? " and more" : ""}. Which time suits you? Please also share your name and email.`;
    }
    if (tool === "book_appointment") {
      return `You're booked! ✅ ${r.service} on ${r.booking.start.slice(0, 10)} at ${r.booking.start.slice(11, 16)}. Your booking ID is ${r.booking.id}. A confirmation will be sent to ${r.booking.email}. Please give us 24h notice if you need to cancel.`;
    }
    if (tool === "cancel_appointment") return `Done. Booking ${r.booking.id} has been cancelled. Hope to see you soon!`;
    // get_business_info: answer the specific question if we can
    const q = [...messages].reverse().find((m) => m.role === "user") as { content: string } | undefined;
    const text = (q?.content ?? "").toLowerCase();
    const faq = r.faq.find((f: { q: string }) => text.includes(f.q) || (f.q === "cancellation" && text.includes("cancel")));
    if (faq) return faq.a;
    if (/price|cost|how much|service/.test(text)) return "Our services: " + r.services.map((s: any) => `${s.name} (${s.minutes} min, ${s.price})`).join("; ") + ". Would you like to book one?";
    if (/hour|open|close|when/.test(text)) return `We're open Mon–Wed 9:00–17:00, Thu 9:00–19:00 and Fri 9:00–15:00 (closed weekends). We're at ${r.address}.`;
    if (/where|address|location|park/.test(text)) return `We're at ${r.address}. Free parking is available behind the building.`;
    return `Hi! I'm the ${r.name} assistant. I can answer questions about prices, hours and insurance, or book an appointment for you. How can I help?`;
  }

  private lastMatch(text: string, words: string[]): string | undefined {
    let best: string | undefined, pos = -1;
    for (const w of words) { const i = text.lastIndexOf(w); if (i > pos) { pos = i; best = w; } }
    return best;
  }

  private lastDate(text: string, today: string): string | undefined {
    const candidates: [number, string][] = [];
    for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) candidates.push([m.index!, m[0]]);
    const t = new Date(today + "T00:00:00Z");
    const add = (d: number) => new Date(t.getTime() + d * 86400000).toISOString().slice(0, 10);
    for (const m of text.matchAll(/\btomorrow\b/g)) candidates.push([m.index!, add(1)]);
    for (const m of text.matchAll(/\btoday\b/g)) candidates.push([m.index!, today]);
    WEEKDAYS.forEach((w, wd) => {
      for (const m of text.matchAll(new RegExp(`\\b${w}\\b`, "g"))) {
        const diff = ((wd - t.getUTCDay() + 7) % 7) || 7;
        candidates.push([m.index!, add(diff)]);
      }
    });
    return candidates.sort((a, b) => a[0] - b[0]).pop()?.[1];
  }

  private parseTime(text: string): string | undefined {
    const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text) ?? /\bat\s+(\d{1,2}):(\d{2})\b/.exec(text);
    if (!m) return;
    let h = Number(m[1]);
    const min = m[2] ?? "00";
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }
}
