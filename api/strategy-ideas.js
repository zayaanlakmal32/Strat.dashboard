// Vercel Serverless Function
// Pulls every strategy-flagged (⭐) idea from each active client's Notion
// Content Board and reports execution status — live, on every request.
//
// Data source of truth: your existing "📊 Project Tracker" data source, which
// already stores each client's "Content Board Data Source ID". No guessing,
// no separate lookup table — this just reads what you already maintain.
//
// Performance tab: PO ranking + a 6-week rolling trend are computed fresh
// from each idea's own Created time / Publish Date, both of which Notion
// already stores permanently. No separate history database needed — the
// "history" is just re-derived from the same live data every time.

const NOTION_VERSION = "2025-09-03";
const PROJECT_TRACKER_DATA_SOURCE_ID = "b6b396fe-f0cf-4d7e-9845-e18c630c0ae7";
const STAR = "\u{1F31F}"; // 🌟
const {
  buildStrategyCallReport,
  fetchStrategyCalendarEvents,
  readGhlConfig
} = require("../lib/strategy-calls");

// Some client boards phrase their Status options slightly differently
// (e.g. "Published" vs "PUBLISHED"). Classify by keyword instead of an
// exact list, so this doesn't silently break per client.
function classifyStatus(status) {
  const s = (status || "").trim().toLowerCase();
  if (!s) return "gray";
  if (s.includes("do not progress") || s.includes("on hold")) return "excluded";
  if (s.includes("publish")) return "published";
  if (s.includes("posting")) return "almost";
  if (s === "topics" || s === "backlog" || s === "not started") return "gray";
  return "progress"; // any other production stage (writing/filming/editing/review/etc.)
}

// Simple in-memory cache so opening the dashboard a few times in a row
// doesn't re-hit ~35 Notion queries every time. Resets on cold start.
// Pass ?force=1 to bypass it.
let cache = { data: null, at: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function notion(path, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || `Notion API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function queryAll(dataSourceId, filter) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const page = await notion(`data_sources/${dataSourceId}/query`, body);
    results = results.concat(page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ---- tiny property readers (Notion REST API shapes) ----
const getTitle = (p) => (p?.title || []).map(t => t.plain_text).join("");
const getSelect = (p) => p?.select?.name || null;
const getRichText = (p) => (p?.rich_text || []).map(t => t.plain_text).join("");
const getStatus = (p) => p?.status?.name || null;
const getDate = (p) => p?.date?.start || null;
const getCreatedTime = (p) => p?.created_time || null;

async function getActiveClients() {
  const filter = {
    and: [
      { property: "Stage", select: { does_not_equal: "Offboarded" } },
      { property: "Content Board Data Source ID", rich_text: { is_not_empty: true } }
    ]
  };
  const rows = await queryAll(PROJECT_TRACKER_DATA_SOURCE_ID, filter);
  return rows
    .map(r => ({
      name: getTitle(r.properties["Client Name"]),
      po: getSelect(r.properties["PO Name"]),
      projectType: getSelect(r.properties["Project Type"]),
      stage: getSelect(r.properties["Stage"]),
      contentBoardId: getRichText(r.properties["Content Board Data Source ID"]).trim()
    }))
    .filter(c => c.contentBoardId);
}

async function getStarIdeas(contentBoardId) {
  const filter = { property: "Name", title: { contains: STAR } };
  const pages = await queryAll(contentBoardId, filter);
  return pages.map(p => ({
    name: getTitle(p.properties["Name"]),
    status: getStatus(p.properties["Status"]),
    created: getCreatedTime(p.properties["Created time"]) || p.created_time,
    publishDate: getDate(p.properties["Publish Date"]),
    inspo: p.properties["Inspo"]?.url || null,
    url: p.url
  }));
}

// concurrency-limited map so we don't fire 35+ requests at Notion at once
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

function enrichIdea(raw, now) {
  const created = new Date(raw.created);
  const checkBy = new Date(created.getTime() + 7 * 86400000);
  const daysLeft = Math.round((checkBy - now) / 86400000);
  const bucket = classifyStatus(raw.status);
  const executed = bucket === "published";
  const excluded = bucket === "excluded";
  const overdue = !executed && !excluded && daysLeft < 0;
  return { ...raw, checkBy: checkBy.toISOString().slice(0, 10), daysLeft, bucket, executed, excluded, overdue };
}

// PO performance: aggregate each PO's clients, plus a 6-week rolling
// on-time-delivery trend derived purely from each idea's own checkBy /
// publishDate — no snapshot storage needed, it's recomputed fresh each time.
const TREND_WEEKS = 6;

function buildPerformance(clientReports, now) {
  const withIdeas = clientReports.filter(c => c.stats.suggested > 0 && c.po);
  const byPo = {};
  withIdeas.forEach(c => {
    const po = c.po;
    if (!byPo[po]) byPo[po] = { po, clientsTotal: 0, clientsOnTrack: 0, suggested: 0, executed: 0, excluded: 0, ideas: [] };
    const b = byPo[po];
    b.clientsTotal += 1;
    if (c.stats.overdue === 0) b.clientsOnTrack += 1;
    b.suggested += c.stats.suggested;
    b.executed += c.stats.executed;
    b.excluded += c.stats.excluded;
    b.ideas.push(...c.ideas);
  });

  const result = Object.values(byPo).map(b => {
    const denom = b.suggested - b.excluded;
    const pct = denom > 0 ? Math.round((b.executed / denom) * 100) : null;

    // bucket[0] = 1 week ago, bucket[5] = 6 weeks ago
    const buckets = new Array(TREND_WEEKS).fill(null).map(() => ({ total: 0, onTime: 0 }));
    b.ideas.forEach(idea => {
      if (idea.excluded) return;
      const checkByDate = new Date(idea.checkBy);
      const weeksAgo = Math.floor((now - checkByDate) / (7 * 86400000));
      if (weeksAgo >= 1 && weeksAgo <= TREND_WEEKS) {
        const slot = buckets[weeksAgo - 1];
        slot.total += 1;
        const onTime = idea.executed && (!idea.publishDate || new Date(idea.publishDate) <= checkByDate);
        if (onTime) slot.onTime += 1;
      }
    });
    const trend = buckets.slice().reverse().map(s => s.total > 0 ? Math.round((s.onTime / s.total) * 100) : null);
    const nonNull = trend.filter(v => v !== null);
    const delta = nonNull.length >= 2 ? nonNull[nonNull.length - 1] - nonNull[nonNull.length - 2] : null;

    return {
      po: b.po,
      clientsTotal: b.clientsTotal,
      clientsOnTrack: b.clientsOnTrack,
      suggested: b.suggested,
      executed: b.executed,
      excluded: b.excluded,
      pct,
      trend,
      delta
    };
  });

  result.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  return result;
}

async function buildReport() {
  const now = new Date();
  const clients = await getActiveClients();
  const errors = [];

  const clientReports = await mapLimit(clients, 5, async (client) => {
    try {
      const rawIdeas = await getStarIdeas(client.contentBoardId);
      const ideas = rawIdeas.map(i => enrichIdea(i, now));
      const suggested = ideas.length;
      const excluded = ideas.filter(i => i.excluded).length;
      const executed = ideas.filter(i => i.executed).length;
      const overdue = ideas.filter(i => i.overdue).length;
      const denom = suggested - excluded;
      const pct = denom > 0 ? Math.round((executed / denom) * 100) : null;
      return { ...client, ideas, stats: { suggested, executed, excluded, overdue, pct } };
    } catch (e) {
      errors.push({ client: client.name, message: e.message });
      return {
        ...client, ideas: [],
        stats: { suggested: 0, executed: 0, excluded: 0, overdue: 0, pct: null },
        loadError: e.message
      };
    }
  });

  const withIdeas = clientReports.filter(c => c.stats.suggested > 0);
  const totalSuggested = withIdeas.reduce((a, c) => a + c.stats.suggested, 0);
  const totalExecuted = withIdeas.reduce((a, c) => a + c.stats.executed, 0);
  const totalExcluded = withIdeas.reduce((a, c) => a + c.stats.excluded, 0);
  const totalOverdue = withIdeas.reduce((a, c) => a + c.stats.overdue, 0);
  const denom = totalSuggested - totalExcluded;

  const performance = buildPerformance(clientReports, now);
  const ghlConfig = readGhlConfig();
  const missingGhlConfig = [
    !ghlConfig.token && "GHL_ACCESS_TOKEN",
    !ghlConfig.locationId && "GHL_LOCATION_ID",
    !ghlConfig.calendarId && "GHL_STRATEGY_CALENDAR_ID"
  ].filter(Boolean);
  let calls = {
    ...buildStrategyCallReport(clientReports, [], now),
    configured: missingGhlConfig.length === 0,
    missingConfig: missingGhlConfig,
    error: null,
    rangeStart: null,
    rangeEnd: null,
    eventsFetched: 0
  };

  if (calls.configured) {
    try {
      const calendar = await fetchStrategyCalendarEvents(ghlConfig, now);
      calls = {
        ...buildStrategyCallReport(clientReports, calendar.events, now),
        configured: true,
        missingConfig: [],
        error: null,
        rangeStart: calendar.rangeStart,
        rangeEnd: calendar.rangeEnd,
        eventsFetched: calendar.events.length
      };
    } catch (error) {
      calls.error = error.message;
    }
  }

  return {
    asOf: now.toISOString(),
    overall: {
      activeClients: clients.length,
      clientsWithIdeas: withIdeas.length,
      totalSuggested, totalExecuted, totalExcluded, totalOverdue,
      pct: denom > 0 ? Math.round((totalExecuted / denom) * 100) : null
    },
    clients: clientReports.sort((a, b) => b.stats.overdue - a.stats.overdue),
    performance,
    calls,
    errors
  };
}

module.exports = async (req, res) => {
  try {
    if (!process.env.NOTION_TOKEN) {
      res.status(500).json({ error: "NOTION_TOKEN is not set in this project's environment variables." });
      return;
    }
    const force = req.query?.force === "1";
    if (!force && cache.data && (Date.now() - cache.at) < CACHE_MS) {
      res.setHeader("X-Cache", "hit");
      res.status(200).json(cache.data);
      return;
    }
    const report = await buildReport();
    cache = { data: report, at: Date.now() };
    res.setHeader("X-Cache", "miss");
    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
};
