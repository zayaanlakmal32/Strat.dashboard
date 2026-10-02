# Strategy Idea Tracker

Live dashboard: for every active client, pulls every strategy-team ⭐ idea from
their Notion Content Board and shows what % has actually been Published.

No manual entry, anywhere. The client list, PO, and each client's Content
Board come straight from your Project Tracker's "Content Board Data Source ID"
column, which you already maintain.

The **Calls** tab reads the strategy calendar directly from GoHighLevel (GHL),
matches events titled `<Client> × Strategy team`, and groups every project by
its PO. Moving an appointment in GHL automatically changes the next-call date
shown here; there is no second manual call tracker.

## How "executed" is worked out

- **Check-by date** = the ⭐ card's Created time + 7 days
- **Executed** = the card's Status is `PUBLISHED`
- **Excluded** = Status is `On Hold` or `Do Not Progress` — pulled out of the
  % entirely, shown with a note instead
- **Overdue** = past its check-by date and still neither of the above

## How the Calls tab is worked out

- **Previous call** = the latest matching GHL event at or before now
- **Next call** = the earliest matching GHL event after now
- **Current call cycle** = from the previous call up to the next call
- **Ideas posted before next call** = non-excluded ⭐ ideas created in that
  cycle whose Notion status is Published before the next call
- If no previous call is found, the dashboard shows `—` instead of guessing a
  cycle score.

GHL remains the source of truth for booking changes. The dashboard reads a
180-day window on either side of today and ignores cancelled appointments.

## Deploy

1. Push this folder to a new GitHub repo.
2. In Vercel: **Add New → Project**, import that repo.
3. Before the first deploy, add these environment variables:
   - `NOTION_TOKEN` — reuse the same value already set on your other
     dashboards (`editoz-dashboard-po`, etc.) — it's the same integration,
     just talking to more databases now.
   - `GHL_ACCESS_TOKEN` — a **Sub-Account Private Integration Token** with the
     `calendars/events.readonly` scope.
   - `GHL_LOCATION_ID` — the GHL sub-account/location ID containing the calls.
   - `GHL_STRATEGY_CALENDAR_ID` — the ID of the GHL calendar used for strategy
     calls.
4. Deploy. That's it — no build step, no dependencies.

The GHL token is only read inside the Vercel serverless function. It is never
sent to the browser. For backwards compatibility, `GHL_PRIVATE_INTEGRATION_TOKEN`
and `GHL_CALENDAR_ID` are also accepted aliases.

## If a client shows a load error

Usually means this Notion integration hasn't been shared with that specific
client's Content Board page. Open that page in Notion → `···` → Connections →
add the same integration your other dashboards use.

## Notes

- Data refreshes on every page load, cached for 5 minutes so repeated opens
  don't hammer Notion. Click the ⟳ button to force an immediate re-pull.
- Event/client matching is intentionally exact after harmless punctuation and
  casing normalization. If a card says no GHL match, confirm its event title is
  exactly `<Client> × Strategy team` and that the client name matches Notion.
