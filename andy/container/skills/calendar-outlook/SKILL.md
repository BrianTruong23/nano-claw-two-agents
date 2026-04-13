---
name: calendar-outlook
description: Manage Google Calendar and Outlook calendar events, scheduling, and availability. Use when the user asks to create, read, update, or delete calendar events, check availability, or schedule meetings.
---

# Calendar & Outlook

Manage calendar events via Rube MCP (preferred) or browser automation (fallback).

## Path A: Rube MCP (Composio)

Requires the Rube MCP server at `https://rube.app/mcp`.

### Setup Check

```
RUBE_SEARCH_TOOLS with query "calendar"
```

If tools are found, proceed with Rube. Otherwise fall back to Path B.

### Connect Account

```
RUBE_MANAGE_CONNECTIONS with action "initiate" and toolkit "googlecalendar"
```
For Outlook:
```
RUBE_MANAGE_CONNECTIONS with action "initiate" and toolkit "outlook-calendar"
```

### Common Operations

**List events:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: googlecalendar
  action: GOOGLECALENDAR_FIND_EVENT
  params: { "calendar_id": "primary", "query": "standup" }
```

**Create event:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: googlecalendar
  action: GOOGLECALENDAR_CREATE_EVENT
  params: {
    "calendar_id": "primary",
    "title": "Team Sync",
    "start_datetime": "2025-01-15T10:00:00",
    "end_datetime": "2025-01-15T10:30:00",
    "attendees": ["alice@example.com"],
    "description": "Weekly sync"
  }
```

**Update event:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: googlecalendar
  action: GOOGLECALENDAR_UPDATE_EVENT
  params: { "event_id": "...", "title": "Updated Title" }
```

**Delete event:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: googlecalendar
  action: GOOGLECALENDAR_DELETE_EVENT
  params: { "event_id": "..." }
```

For Outlook, replace `googlecalendar` with `outlook-calendar` and adjust action names.

## Path B: Browser Automation (Fallback)

Use `agent-browser` when Rube MCP is unavailable:

1. Navigate to `https://calendar.google.com` or `https://outlook.live.com/calendar`
2. User must be signed in (or sign in during session)
3. Use page interactions to create/view events

This path is limited and cannot reliably parse complex calendar grids.

## Tips

- Confirm timezone with user before creating events.
- Use ISO 8601 format for all datetimes.
- For recurring events, specify recurrence rule in params.
