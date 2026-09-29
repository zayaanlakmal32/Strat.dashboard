# Strategy Idea Tracker

Live dashboard: for every active client, pulls every strategy-team ⭐ idea from
their Notion Content Board and shows what % has actually been Published.

No manual entry, anywhere. The client list, PO, and each client's Content
Board come straight from your Project Tracker's "Content Board Data Source ID"
column, which you already maintain.

## How "executed" is worked out

- **Check-by date** = the ⭐ card's Created time + 7 days
- **Executed** = the card's Status is `PUBLISHED`
- **Excluded** = Status is `On Hold` or `Do Not Progress` — pulled out of the
  % entirely, shown with a note instead
- **Overdue** = past its check-by date and still neither of the above

## Deploy

1. Push this folder to a new GitHub repo.
2. In Vercel: **Add New → Project**, import that repo.
3. Before the first deploy, add one environment variable:
   - `NOTION_TOKEN` — reuse the same value already set on your other
     dashboards (`editoz-dashboard-po`, etc.) — it's the same integration,
     just talking to more databases now.
4. Deploy. That's it — no build step, no dependencies.

## If a client shows a load error

Usually means this Notion integration hasn't been shared with that specific
client's Content Board page. Open that page in Notion → `···` → Connections →
add the same integration your other dashboards use.

## Notes

- Data refreshes on every page load, cached for 5 minutes so repeated opens
  don't hammer Notion. Click the ⟳ button to force an immediate re-pull.
- "Strategy Call Date" already exists as a column on Project Tracker if you
  want to add last/next call dates to this later — nothing extra to build
  there when you're ready, just not wired into this version yet.
