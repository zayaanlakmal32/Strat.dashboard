const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function clientNameFromStrategyTitle(title) {
  const match = String(title || "").trim().match(/^(.+?)\s+(?:×|x)\s+strategy\s+team\s*$/i);
  return match ? match[1].trim() : null;
}

function eventStart(event) {
  const raw = event?.startTime ?? event?.start ?? event?.startDateTime;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = new Date(typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isCancelled(event) {
  const status = String(event?.appointmentStatus || event?.status || "").toLowerCase();
  return status.includes("cancel");
}

function compactEvent(event) {
  const start = eventStart(event);
  return {
    id: event.id || null,
    title: event.title || "Strategy call",
    start: start ? start.toISOString() : null,
    end: event.endTime || event.end || event.endDateTime || null,
    calendarId: event.calendarId || null,
    status: event.appointmentStatus || event.status || null
  };
}

function ideasForCallCycle(client, lastCall, nextCall, now) {
  if (!lastCall) {
    return { available: false, suggested: null, posted: null, pct: null };
  }

  const from = new Date(lastCall.start);
  const until = nextCall ? new Date(nextCall.start) : now;
  const ideas = (client.ideas || []).filter((idea) => {
    const created = new Date(idea.created);
    return !Number.isNaN(created.getTime()) && created >= from && created < until && !idea.excluded;
  });
  const posted = ideas.filter((idea) => {
    if (!idea.executed) return false;
    if (!idea.publishDate) return true;
    const published = new Date(idea.publishDate);
    return !Number.isNaN(published.getTime()) && published < until;
  }).length;

  return {
    available: true,
    suggested: ideas.length,
    posted,
    pct: ideas.length ? Math.round((posted / ideas.length) * 100) : null
  };
}

function buildStrategyCallReport(clients, events, now = new Date()) {
  const clientsByName = new Map(clients.map((client) => [normalizeName(client.name), client]));
  const grouped = new Map(clients.map((client) => [client.name, []]));
  const unmatchedEventTitles = [];

  for (const event of events || []) {
    if (isCancelled(event)) continue;
    const extracted = clientNameFromStrategyTitle(event.title);
    const start = eventStart(event);
    if (!extracted || !start) continue;
    const client = clientsByName.get(normalizeName(extracted));
    if (!client) {
      unmatchedEventTitles.push(event.title);
      continue;
    }
    grouped.get(client.name).push({ ...compactEvent(event), start: start.toISOString() });
  }

  const callClients = clients.map((client) => {
    const matched = grouped.get(client.name).sort((a, b) => new Date(a.start) - new Date(b.start));
    const past = matched.filter((event) => new Date(event.start) <= now);
    const future = matched.filter((event) => new Date(event.start) > now);
    const lastCall = past.at(-1) || null;
    const nextCall = future[0] || null;
    const cycle = ideasForCallCycle(client, lastCall, nextCall, now);
    const daysUntilNext = nextCall
      ? Math.ceil((new Date(nextCall.start).getTime() - now.getTime()) / DAY_MS)
      : null;

    return {
      name: client.name,
      po: client.po,
      projectType: client.projectType,
      lastCall,
      nextCall,
      daysUntilNext,
      cycle,
      matchedEvents: matched.length
    };
  });

  return {
    clients: callClients,
    summary: {
      totalClients: callClients.length,
      matchedClients: callClients.filter((client) => client.matchedEvents > 0).length,
      clientsWithNextCall: callClients.filter((client) => client.nextCall).length,
      callsInNext7Days: callClients.filter((client) => client.daysUntilNext !== null && client.daysUntilNext <= 7).length,
      missingMatches: callClients.filter((client) => client.matchedEvents === 0).length,
      postedThisCycle: callClients.reduce((sum, client) => sum + (client.cycle.posted || 0), 0),
      suggestedThisCycle: callClients.reduce((sum, client) => sum + (client.cycle.suggested || 0), 0)
    },
    unmatchedEventTitles: [...new Set(unmatchedEventTitles)].slice(0, 20)
  };
}

function readGhlConfig(env = process.env) {
  return {
    token: env.GHL_ACCESS_TOKEN || env.GHL_PRIVATE_INTEGRATION_TOKEN || "",
    locationId: env.GHL_LOCATION_ID || "",
    calendarId: env.GHL_STRATEGY_CALENDAR_ID || env.GHL_CALENDAR_ID || ""
  };
}

async function fetchStrategyCalendarEvents(config, now = new Date(), fetchImpl = fetch) {
  const rangeStart = new Date(now.getTime() - 180 * DAY_MS);
  const rangeEnd = new Date(now.getTime() + 180 * DAY_MS);
  const url = new URL(`${GHL_BASE_URL}/calendars/events`);
  url.searchParams.set("locationId", config.locationId);
  url.searchParams.set("calendarId", config.calendarId);
  url.searchParams.set("startTime", String(rangeStart.getTime()));
  url.searchParams.set("endTime", String(rangeEnd.getTime()));

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
      Version: "v3"
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.error || `GHL calendar API error (${response.status})`;
    throw new Error(message);
  }

  return {
    events: Array.isArray(body.events) ? body.events : [],
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString()
  };
}

module.exports = {
  buildStrategyCallReport,
  clientNameFromStrategyTitle,
  fetchStrategyCalendarEvents,
  normalizeName,
  readGhlConfig
};
