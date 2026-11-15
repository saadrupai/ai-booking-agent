// Tools the AI agent can call. Each tool validates input and returns plain JSON.
// The LLM never touches the calendar directly — it can only act through these.
import { Scheduler, BookingError } from "./scheduler.ts";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_business_info",
    description: "Get the business name, address, phone, opening hours, services with prices and durations, and FAQ answers (insurance, parking, cancellation, payment).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_availability",
    description: "List free appointment start times for a service on a date. Always call this before booking.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Local date YYYY-MM-DD" },
        service_id: { type: "string", description: "Service id from get_business_info" },
      },
      required: ["date", "service_id"],
    },
  },
  {
    name: "book_appointment",
    description: "Book an appointment. Only call after the customer confirmed the service, date, time, their name and email.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM 24h, must come from check_availability" },
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["service_id", "date", "time", "name", "email"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing booking. Requires the booking ID and the email used to book.",
    input_schema: {
      type: "object",
      properties: { booking_id: { type: "string" }, email: { type: "string" } },
      required: ["booking_id", "email"],
    },
  },
];

export function runTool(s: Scheduler, name: string, input: Record<string, string>): unknown {
  try {
    switch (name) {
      case "get_business_info": {
        const b = s.business;
        return { name: b.name, address: b.address, phone: b.phone, timezone: b.timezone, today: s.today(),
                 hours: b.hours, services: b.services, faq: b.faq };
      }
      case "check_availability":
        return { date: input.date, service_id: input.service_id, free_times: s.availability(input.date, input.service_id) };
      case "book_appointment": {
        const bk = s.book({ serviceId: input.service_id, date: input.date, time: input.time, name: input.name, email: input.email });
        return { ok: true, booking: bk, service: s.service(bk.serviceId).name };
      }
      case "cancel_appointment":
        return { ok: true, booking: s.cancel(input.booking_id, input.email) };
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }; // let the model recover and ask again
    throw e;
  }
}
