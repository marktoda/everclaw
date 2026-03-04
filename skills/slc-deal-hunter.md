---
name: slc-deal-hunter
description: Weekly automated search for NYC↔SLC Delta flight deals
schedule: "0 1 * * 1"
enabled: true
---

# SLC Deal Hunter - Weekly Flight Search

You are monitoring NYC ↔ SLC Delta flight deals for the user.

## User Preferences:
- Route: NYC (JFK/LGA/EWR) ↔ SLC
- Airline: Delta preferred, but mention other airlines if significantly cheaper
- Direct flights only
- Flexible dates (willing to shift for price)
- Avoid work hours: prefer evenings (after 6pm) or weekends
- Stay duration: 1 week to 1 month (flexible)
- Priority: PRICE above all else

## Your Task (runs every Sunday 8pm EST):

### Stage 1: Search Flights
Search nonstop round-trip flights NYC→SLC for the next 4 weekends. Search ONE date at a time — check results before continuing to the next date. Stop early if you get repeated errors or empty results.

Do NOT use the `airline` filter — search all airlines so you can compare.

For each of the next 4 Fridays/Saturdays, with return_date = departure + 14 days:
```
run_script("search-flights", {
  "origin": "JFK",
  "destination": "SLC",
  "date": "YYYY-MM-DD",
  "return_date": "YYYY-MM-DD",
  "nonstop": true
})
```

If JFK has deals (< $400 round-trip), also check EWR and LGA for the cheapest dates.

The script returns:
```json
{
  "flights": [
    {"price": 247, "name": "Delta", "departure": "1:30 PM on Sun, Mar 15", "arrival": "4:53 PM on Sun, Mar 15", "duration": "6 hr 23 min", "stops": 0, "delay": null, "is_best": true}
  ],
  "current_price": "typical",
  "metadata": {"origin": "JFK", "destination": "SLC", "date": "2026-03-15", "return_date": "2026-03-29", "result_count": 5, "raw_result_count": 12}
}
```

**Data quality check:** If every flight on a date returns the same price, treat it as unreliable placeholder pricing — note it in state but don't use it for deal detection.

### Stage 2: Analyze Prices
- Get price-history from state: `get_state("slc-travel", "price-history")`
- From results, focus on Delta flights but note if another airline is >20% cheaper
- Calculate average and minimum Delta prices across all searched dates
- Compare vs. 4-week historical average
- Determine if it's a deal (>15% below average OR < $350 round-trip)

### Stage 3: Generate Booking Links
For each good flight option, construct Google Flights and Delta.com booking URLs directly using the origin, destination, and dates.

### Stage 4: Alert on Deals
IF deal found, send a concise message with:
- The best 3 Delta options (price, date, times, duration)
- Google Flights and Delta.com booking links for each
- Price trend vs. recent weeks (e.g. "down $40 from last week")
- If a non-Delta airline is significantly cheaper, mention it at the bottom

IF no deal:
- Stay silent (don't send "no deals" message)
- Just update price history

### Stage 5: Update State
Save to `set_state("slc-travel", "price-history")`. Keep last 12 weeks. Each entry:

```json
{
  "week": "2026-03-03",
  "avg_price": 320,
  "min_price": 287,
  "samples": 8,
  "top_flights": [
    {"price": 287, "name": "Delta", "origin": "JFK", "date": "2026-03-15", "departure": "1:30 PM", "duration": "6 hr 23 min"},
    {"price": 299, "name": "Delta", "origin": "JFK", "date": "2026-03-14", "departure": "7:00 AM", "duration": "6 hr 18 min"},
    {"price": 314, "name": "JetBlue", "origin": "JFK", "date": "2026-03-15", "departure": "12:00 PM", "duration": "6 hr 22 min"}
  ],
  "cheapest_non_delta": {"price": 250, "name": "JetBlue", "date": "2026-03-15"}
}
```

## Error Handling:
- If search-flights returns an `error` field: retry once, then skip that date
- If 2+ consecutive dates fail: stop searching and note the failure in state
- If no results found: note in history, don't alert
- If state read fails: initialize with empty history

## Notes:
- Build price baseline over first 4 weeks before alerting
- Be conservative with "deal" threshold in early weeks
- Include 2 booking link types: Google Flights + Delta.com
- Do NOT include Kayak or other third-party aggregator links
- Delta links include pre-filled dates and airports
- User has a house in SLC, so no hotel search needed
