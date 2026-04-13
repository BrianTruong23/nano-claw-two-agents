---
name: deep-research
description: Conduct structured multi-source research with citations and synthesis. Use when the user asks to research a topic in depth, compare options, produce a review, or investigate a question requiring multiple sources.
---

# Deep Research

Follow this methodology for thorough, cited research.

## 1. Decompose the Query

Break the question into 3-5 sub-questions. Example: "Best database for my app?" becomes:
- What are the requirements (read-heavy? write-heavy? schema flexibility)?
- Which databases match?
- What are the trade-offs (cost, ops complexity, ecosystem)?
- What do production users report?

## 2. Gather Sources

Use multiple tools in parallel when possible:

- **WebSearch** -- broad keyword queries, recent results, quick facts
- **WebFetch** -- retrieve specific URLs (docs, blog posts, benchmarks)
- **agent-browser** -- interactive pages, login-gated content, dynamic sites

Search each sub-question independently. Vary keywords to avoid single-source bias.

## 3. Evaluate and Cross-Reference

- Prefer primary sources (official docs, RFCs, papers) over secondary (blogs, forums).
- Note publication dates -- discard stale benchmarks or deprecated docs.
- When sources conflict, present both sides with attribution.
- Flag sponsored content or vendor benchmarks.

## 4. Synthesize

Structure output as:

```
## Summary (2-3 sentences)

## Findings
### Sub-question 1
- Key point [Source](url)
- Contrasting view [Source](url)

### Sub-question 2
...

## Recommendation (if asked)

## Sources
1. [Title](url)
```

## 5. Iterate

After the first pass, identify gaps:
- Are any sub-questions unanswered?
- Did new terms appear that deserve follow-up?
- Does the user need more depth on a specific area?

Run additional searches to fill gaps before finalizing.

## Tips

- Save interim notes to `/workspace/group/research-notes.md` for long investigations.
- For technical comparisons, look for benchmark repos on GitHub.
- When the user says "deep dive," aim for 5+ distinct sources per sub-question.
- Always include URLs so the user can verify findings.
