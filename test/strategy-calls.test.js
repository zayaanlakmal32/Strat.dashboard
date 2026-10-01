const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStrategyCallReport,
  clientNameFromStrategyTitle,
  normalizeName
} = require("../lib/strategy-calls");

test("extracts the client from the agreed GHL event title", () => {
  assert.equal(clientNameFromStrategyTitle("Valeria × Strategy team"), "Valeria");
  assert.equal(clientNameFromStrategyTitle("Valeria x Strategy Team"), "Valeria");
  assert.equal(clientNameFromStrategyTitle("Internal sync"), null);
});

test("normalizes harmless name punctuation without fuzzy matching", () => {
  assert.equal(normalizeName("A & M Cupcakes"), normalizeName("A and M Cupcakes"));
  assert.notEqual(normalizeName("Alex"), normalizeName("Alexander"));
});

test("selects previous and next live calls and counts this cycle's posted ideas", () => {
  const now = new Date("2026-10-02T06:00:00.000Z");
  const clients = [{
    name: "Valeria",
    po: "Vishaka",
    projectType: "Accelerate",
    ideas: [
      { created: "2026-09-22T08:00:00.000Z", publishDate: "2026-09-28", executed: true, excluded: false },
      { created: "2026-09-25T08:00:00.000Z", publishDate: null, executed: false, excluded: false },
      { created: "2026-09-26T08:00:00.000Z", publishDate: null, executed: false, excluded: true },
      { created: "2026-09-01T08:00:00.000Z", publishDate: "2026-09-03", executed: true, excluded: false }
    ]
  }];
  const events = [
    { id: "old", title: "Valeria × Strategy team", startTime: "2026-09-20T06:00:00.000Z" },
    { id: "next", title: "Valeria × Strategy team", startTime: "2026-10-04T06:00:00.000Z" },
    { id: "cancelled", title: "Valeria × Strategy team", startTime: "2026-10-03T06:00:00.000Z", status: "cancelled" }
  ];

  const report = buildStrategyCallReport(clients, events, now);
  const valeria = report.clients[0];
  assert.equal(valeria.lastCall.id, "old");
  assert.equal(valeria.nextCall.id, "next");
  assert.equal(valeria.daysUntilNext, 2);
  assert.deepEqual(valeria.cycle, { available: true, suggested: 2, posted: 1, pct: 50 });
  assert.equal(report.summary.callsInNext7Days, 1);
});

test("does not invent a cycle score when no previous call is available", () => {
  const report = buildStrategyCallReport(
    [{ name: "Alex", po: "Rovindu", ideas: [] }],
    [{ id: "next", title: "Alex × Strategy team", startTime: "2026-10-04T06:00:00.000Z" }],
    new Date("2026-10-02T06:00:00.000Z")
  );
  assert.equal(report.clients[0].cycle.available, false);
  assert.equal(report.clients[0].cycle.posted, null);
});
