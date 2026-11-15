// Provider-neutral chat-with-tools interface + Anthropic and OpenAI implementations.
import type { ToolDef } from "./tools.ts";

export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolCall { id: string; name: string; input: Record<string, string> }
export interface LLMReply { text: string; toolCalls: ToolCall[] }

export interface LLM {
  name: string;
  chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<LLMReply>;
}

export class AnthropicLLM implements LLM {
  name = "anthropic";
  private apiKey: string;
  private model: string;
  constructor(apiKey: string, model = "claude-sonnet-5-5") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<LLMReply> {
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === "user") out.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        out.push({ role: "assistant", content });
      } else {
        out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] });
      }
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, system, tools, messages: out }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    const data = await r.json() as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, string> }[] };
    return {
      text: data.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      toolCalls: data.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, input: b.input ?? {} })),
    };
  }
}

export class OpenAILLM implements LLM {
  name = "openai";
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  constructor(apiKey: string, model = "gpt-4o-mini", baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<LLMReply> {
    const out: unknown[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") out.push({ role: "user", content: m.content });
      else if (m.role === "assistant") out.push({
        role: "assistant", content: m.content || null,
        tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) : undefined,
      });
      else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
    const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model, temperature: 0.2, messages: out,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${await r.text()}`);
    const data = await r.json() as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const msg = data.choices[0].message;
    return {
      text: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") })),
    };
  }
}
