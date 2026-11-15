// The agent loop: send conversation + tools to the LLM, execute any tool calls,
// feed results back, repeat until the model answers in plain text.
import { Scheduler } from "./scheduler.ts";
import { TOOLS, runTool } from "./tools.ts";
import type { LLM, Msg } from "./llm.ts";

const MAX_STEPS = 6; // hard stop so a confused model can't loop forever

export function systemPrompt(s: Scheduler): string {
  const b = s.business;
  return `You are the friendly booking assistant for ${b.name}. Today is ${s.today()} (${b.timezone}).
Your job: answer questions about the clinic and book, check or cancel appointments.
Rules:
- Use get_business_info for prices, hours, services and policies. Never invent facts.
- ALWAYS call check_availability before offering times; only offer times it returns.
- Before booking, confirm service, date, time, the customer's full name and email.
- After booking, give the booking ID and remind them of the cancellation policy.
- Resolve relative dates ("tomorrow", "next Monday") using today's date.
- For medical emergencies outside opening hours, tell them to call 911.
- Keep replies short and warm (1-4 sentences).`;
}

export class Agent {
  private sessions = new Map<string, Msg[]>();
  private scheduler: Scheduler;
  private llm: LLM;

  constructor(scheduler: Scheduler, llm: LLM) {
    this.scheduler = scheduler;
    this.llm = llm;
  }

  async reply(sessionId: string, userText: string): Promise<{ text: string; toolsUsed: string[] }> {
    const history = this.sessions.get(sessionId) ?? [];
    history.push({ role: "user", content: userText.slice(0, 2000) });
    const toolsUsed: string[] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await this.llm.chat(systemPrompt(this.scheduler), history, TOOLS);
      history.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
      if (!r.toolCalls.length) {
        this.sessions.set(sessionId, history.slice(-30)); // bound memory per session
        return { text: r.text, toolsUsed };
      }
      for (const call of r.toolCalls) {
        toolsUsed.push(call.name);
        const result = runTool(this.scheduler, call.name, call.input);
        history.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
      }
    }
    this.sessions.set(sessionId, history.slice(-30));
    return { text: "Sorry, I got stuck. Could you rephrase that, or call us directly?", toolsUsed };
  }
}
