// Availability + booking engine. All times are handled in the business's local
// wall-clock time via a fixed UTC offset, and stored as ISO strings with offset.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

export interface Service { id: string; name: string; minutes: number; price: string }
export interface Business {
  name: string; description: string; timezone: string; utcOffsetMinutes: number;
  address: string; phone: string; slotMinutes: number;
  hours: Record<string, [string, string] | null>;
  services: Service[];
  faq: { q: string; a: string }[];
}
export interface Booking {
  id: string; serviceId: string; name: string; email: string;
  start: string; end: string; createdAt: string; status: "confirmed" | "cancelled";
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class BookingError extends Error {}

export class Scheduler {
  private bookings: Booking[] = [];
  readonly business: Business;
  private readonly storePath?: string;
  private readonly now: () => Date;

  constructor(business: Business, storePath?: string, now: () => Date = () => new Date()) {
    this.business = business;
    this.storePath = storePath;
    this.now = now;
    if (storePath && existsSync(storePath)) this.bookings = JSON.parse(readFileSync(storePath, "utf8"));
  }

  service(id: string): Service {
    const s = this.business.services.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!s) throw new BookingError(`Unknown service "${id}". Options: ${this.business.services.map((x) => x.id).join(", ")}`);
    return s;
  }

  /** Free start times (local "HH:MM") on a local date "YYYY-MM-DD" for a service. */
  availability(date: string, serviceId: string): string[] {
    const svc = this.service(serviceId);
    const day = this.localDate(date);
    const hours = this.business.hours[DAYS[day.getUTCDay()]];
    if (!hours) return [];
    const [open, close] = hours.map(toMinutes);
    const slots: string[] = [];
    for (let m = open; m + svc.minutes <= close; m += this.business.slotMinutes) {
      const start = this.toInstant(date, m);
      const end = new Date(start.getTime() + svc.minutes * 60_000);
      if (start.getTime() <= this.now().getTime() + 60 * 60_000) continue; // need 1h notice
      if (!this.overlaps(start, end)) slots.push(fromMinutes(m));
    }
    return slots;
  }

  book(input: { serviceId: string; date: string; time: string; name: string; email: string }): Booking {
    const svc = this.service(input.serviceId);
    if (!input.name?.trim()) throw new BookingError("Customer name is required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email ?? "")) throw new BookingError("A valid email is required.");
    if (!this.availability(input.date, svc.id).includes(input.time)) {
      throw new BookingError(`${input.time} on ${input.date} is not available for ${svc.name}.`);
    }
    const start = this.toInstant(input.date, toMinutes(input.time));
    const end = new Date(start.getTime() + svc.minutes * 60_000);
    const booking: Booking = {
      id: "BK-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      serviceId: svc.id, name: input.name.trim(), email: input.email.trim().toLowerCase(),
      start: this.iso(start), end: this.iso(end), createdAt: new Date().toISOString(), status: "confirmed",
    };
    this.bookings.push(booking);
    this.save();
    return booking;
  }

  cancel(id: string, email: string): Booking {
    const b = this.bookings.find((x) => x.id === id && x.status === "confirmed");
    // Require the email too, so nobody can cancel someone else's booking by guessing an ID.
    if (!b || b.email !== email.trim().toLowerCase()) throw new BookingError("Booking not found for that ID and email.");
    b.status = "cancelled";
    this.save();
    return b;
  }

  list(): Booking[] { return this.bookings.filter((b) => b.status === "confirmed"); }

  /** Today's date in the business timezone, as YYYY-MM-DD. */
  today(): string { return this.iso(this.now()).slice(0, 10); }

  private overlaps(start: Date, end: Date): boolean {
    return this.list().some((b) => new Date(b.start) < end && start < new Date(b.end));
  }

  private localDate(date: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BookingError(`Dates must be YYYY-MM-DD, got "${date}".`);
    return new Date(date + "T00:00:00Z");
  }

  private toInstant(date: string, minutes: number): Date {
    const utc = this.localDate(date).getTime() + (minutes - this.business.utcOffsetMinutes) * 60_000;
    return new Date(utc);
  }

  /** ISO string in business local time with offset, e.g. 2026-11-20T14:00:00-05:00 */
  iso(d: Date): string {
    const off = this.business.utcOffsetMinutes;
    const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  private save(): void {
    if (!this.storePath) return;
    const tmp = this.storePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.bookings, null, 2));
    renameSync(tmp, this.storePath); // atomic replace
  }
}

export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new BookingError(`Times must be HH:MM (24h), got "${hhmm}".`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
