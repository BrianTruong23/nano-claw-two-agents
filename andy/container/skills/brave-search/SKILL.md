---
name: brave-search
description: Search the public web with Brave Search API or browser fallback. Use for facts, docs, versions, CVEs, library APIs, or anything needing current information.
---

# Brave search (web)

## API search (preferred)

Set **`BRAVE_SEARCH_API_KEY`** on the host (Andy/Bob `.env`). The container receives it automatically.

Run a search by emitting a **tool line** the runner parses (backticks or plain line):

```text
`web-search TypeScript 5.6 release notes`
```

Same tool accepts **`websearch`** (no hyphen) as an alias.

Returns web results (title, URL, snippet, optional extra page excerpts). Default count 10. No API key returns a short message; use fallback below.

### Why paper results look irrelevant

Brave **Web Search** ranks the open web (blogs, SEO, news), **not** a citation index like Google Scholar. Vague queries return vague pages.

**Fix:** put narrowing operators **inside** the same `web-search` line, for example:

- `"exact title phrase"` (quotes)
- `filetype:pdf`
- `site:arxiv.org` or `site:dl.acm.org` or `site:ieee.org`
- Exclude junk: `-slideshare -ppt`

**Runner defaults (research-like queries):** If the line looks like papers / HCI / OpenClaw-style research (and you did not already add `filetype:` or `site:`), the agent-runner runs **two** Brave queries in parallel (your words plus `filetype:pdf`, and the same plus `site:arxiv.org`), then **merges** and dedupes by URL. Set host env **`BRAVE_SEARCH_DUAL_ACADEMIC=false`** to disable that and use a single query only.

On non-dual runs, the runner appends **`filetype:pdf`** when the query still looks research-like. Set **`BRAVE_SEARCH_APPEND_ACADEMIC=false`** to turn that off.

### OpenClaw + HCI templates

Use quoted multi-word phrases so SEO blogs rank lower:

```text
`web-search "OpenClaw" OR "NanoClaw" HCI paper`
`web-search "OpenClaw" human-computer interaction filetype:pdf`
`web-search "OpenClaw" site:arxiv.org OR site:dl.acm.org`
```

Other optional env (passed into the container): `BRAVE_SEARCH_LANG`, `BRAVE_SEARCH_UI_LANG`, `BRAVE_SEARCH_COUNTRY` (ISO-2), `BRAVE_SEARCH_COUNT` (1-20).

## Fallback (no API key)

Use **agent-browser** with a plain query; the runner opens Brave Search results:

```text
`agent-browser open your search words here`
```

For full pages or JS-heavy sites, keep using **agent-browser** after you have a URL.

## When to use

- Verify claims, look up official docs, compare versions, find GitHub issues or CVE text.
- Prefer **`web-search`** for quick SERP-style answers; prefer **agent-browser** for reading a specific page or logging in.
