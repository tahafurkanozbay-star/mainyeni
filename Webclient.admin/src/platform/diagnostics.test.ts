import { describe, expect, test, vi } from "vitest";
import { DiagnosticJournal } from "./diagnostics";

describe("DiagnosticJournal", () => {
  test("records normalized events", () => {
    const journal = new DiagnosticJournal({ now: () => 42 });
    const event = journal.record({
      domain: "ui",
      code: " menu open ",
      message: "  menu   opened  ",
      detail: { count: 2 },
    });
    expect(event).toEqual({
      id: 1,
      timestamp: 42,
      level: "info",
      domain: "ui",
      code: "menu-open",
      message: "menu opened",
      detail: { count: 2 },
    });
  });

  test("bounds retained events and tracks drops", () => {
    const journal = new DiagnosticJournal({ capacity: 10 });
    for (let index = 0; index < 15; index += 1) {
      journal.record({ domain: "ui", code: `event-${index}`, message: String(index) });
    }
    const snapshot = journal.snapshot();
    expect(snapshot.size).toBe(10);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.events[0]?.id).toBe(6);
    expect(snapshot.latest?.id).toBe(15);
  });

  test("counts warning and error levels", () => {
    const journal = new DiagnosticJournal();
    journal.record({ domain: "ui", code: "a", message: "a" });
    journal.warning("routing", "legacy-route", "Legacy route");
    journal.error("http", "request-failed", new Error("network"));
    expect(journal.snapshot()).toMatchObject({
      size: 3,
      warningCount: 1,
      errorCount: 1,
    });
  });

  test("limits snapshot result count without mutating storage", () => {
    const journal = new DiagnosticJournal({ capacity: 20 });
    for (let index = 0; index < 8; index += 1) {
      journal.record({ domain: "ui", code: "x", message: String(index) });
    }
    expect(journal.snapshot(3).events).toHaveLength(3);
    expect(journal.snapshot().size).toBe(8);
  });

  test("isolates observer failures", () => {
    const observer = vi.fn(() => {
      throw new Error("observer failed");
    });
    const journal = new DiagnosticJournal({ onEvent: observer });
    expect(() => journal.record({ domain: "ui", code: "x", message: "ok" })).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test("clear resets retained events and drop count", () => {
    const journal = new DiagnosticJournal({ capacity: 10 });
    for (let index = 0; index < 12; index += 1) {
      journal.record({ domain: "ui", code: "x", message: String(index) });
    }
    journal.clear();
    expect(journal.snapshot()).toMatchObject({ size: 0, dropped: 0 });
  });

  test("sanitizes long codes and messages", () => {
    const journal = new DiagnosticJournal();
    const event = journal.record({
      domain: "ui",
      code: `A ${"x".repeat(120)}`,
      message: "m".repeat(800),
    });
    expect(event.code.length).toBeLessThanOrEqual(80);
    expect(event.message.length).toBe(500);
  });
});
