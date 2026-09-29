// Vercel Serverless Function
// Pulls every strategy-flagged (⭐) idea from each active client's Notion
// Content Board and reports execution status — live, on every request.
//
// Data source of truth: your existing "📊 Project Tracker" data source, which
// already stores each client's "Content Board Data Source ID". No guessing,
// no separate lookup table — this just reads what you already maintain.

const NOTION_VERSION = "2025-09-03";
const PROJECT_TRACKER_DATA_SOURCE_ID = "b6b396fe-f0cf-4d7e-9845-e18c630c0ae7";
const STAR = "\u{1F31F}"; // 🌟

// Content Board "Status" options, bucketed. Adjust here if a client board
// ever adds/renames a status — this is the only place that needs updating.
const STATUS_BUCKET = {
  "Topics": "gray",
  "Need writing": "progress", "Writing": "progress", "Writing Review": "progress",
  "Need filming": "progress", "Need editing": "progress", "Editing": "progress",
  "Revision": "progress", "Edit Review": "progress", "QC Review": "progress",
  "PO Review": "progress", "Client Review": "progress",
  "Need posting": "almost",
  "PUBLISHED": "published",
  "On Hold": "excluded", "Do Not Progress": "excluded", "Backlog": "gray"
};

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
  const bucket = STATUS_BUCKET[raw.status] || "gray";
  const executed = bucket === "published";
  const excluded = bucket === "excluded";
  const overdue = !executed && !excluded && daysLeft < 0;
  return { ...raw, checkBy: checkBy.toISOString().slice(0, 10), daysLeft, bucket, executed, excluded, overdue };
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

  return {
    asOf: now.toISOString(),
    overall: {
      activeClients: clients.length,
      clientsWithIdeas: withIdeas.length,
      totalSuggested, totalExecuted, totalExcluded, totalOverdue,
      pct: denom > 0 ? Math.round((totalExecuted / denom) * 100) : null
    },
    clients: clientReports.sort((a, b) => b.stats.overdue - a.stats.overdue),
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
