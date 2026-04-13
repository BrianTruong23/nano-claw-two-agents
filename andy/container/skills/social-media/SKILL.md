---
name: social-media
description: Automate LinkedIn, Reddit, and Instagram interactions including posting, monitoring, and content extraction. Use when the user asks to post on social media, scrape profiles, monitor subreddits, or manage social accounts.
---

# Social Media Automation

Post, read, and monitor social platforms via Rube MCP or browser fallback.

## Path A: Rube MCP (Composio) -- Preferred

### Connect Accounts

```
RUBE_MANAGE_CONNECTIONS with action "initiate" and toolkit "linkedin"
RUBE_MANAGE_CONNECTIONS with action "initiate" and toolkit "reddit"
RUBE_MANAGE_CONNECTIONS with action "initiate" and toolkit "instagram"
```

### LinkedIn

**Create a post:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: linkedin
  action: LINKEDIN_CREATE_POST
  params: { "text": "Excited to announce..." }
```

**View profile:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: linkedin
  action: LINKEDIN_GET_PROFILE
  params: { "profile_url": "https://linkedin.com/in/username" }
```

### Reddit

**Create a post:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: reddit
  action: REDDIT_SUBMIT
  params: { "subreddit": "programming", "title": "...", "text": "..." }
```

**Read subreddit:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: reddit
  action: REDDIT_GET_HOT_POSTS
  params: { "subreddit": "programming", "limit": 10 }
```

**Post a comment:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: reddit
  action: REDDIT_COMMENT
  params: { "thing_id": "t3_abc123", "text": "Great point!" }
```

### Instagram

**View profile:**
```
RUBE_MULTI_EXECUTE_TOOL
  toolkit: instagram
  action: INSTAGRAM_GET_PROFILE
  params: { "username": "example" }
```

## Path B: Browser Automation (Fallback)

Use `agent-browser` for read-only tasks when Rube MCP is unavailable:

1. **Reddit** -- navigate to `https://old.reddit.com/r/<subreddit>`
2. **LinkedIn** -- public profile URLs; login may be required
3. **Instagram** -- `https://www.instagram.com/<username>/`; limited without login

Browser posting is fragile. Prefer Rube MCP for write operations.

## Tips

- Draft post content and show to user for approval before publishing.
- For Reddit, check subreddit rules before posting.
- LinkedIn posts have a 3000 character limit.
- Rate limiting applies -- space out bulk operations.
- Never store or log social media credentials.
