┌────────────────────────────────────────────────┬───────────────────────┬──────────────────────┬────────────────────────┐
│ Feature │ OpenClaw │ NanoClaw │ Everclaw │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Multi-channel (WhatsApp, Discord, Slack, etc.) │ 20+ channels │ 5 channels │ Telegram only │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Multi-LLM support (OpenAI, Gemini, local) │ Yes │ Claude-only │ Claude-only │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Container isolation for agent execution │ No │ Core feature │ No │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ MCP server integration │ Yes (13K+ servers) │ Via Claude Agent SDK │ No │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Persistent personality (SOUL.md) │ Yes │ Per-group CLAUDE.md │ Notes only │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Skill registry / sharing │ ClawHub (13K+ skills) │ Fork-and-transform │ Local only │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Agent swarms (parallel agents on one task) │ No │ Yes │ No (serial spawn_task) │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Web browser control │ Yes │ No │ No │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Per-group/per-user memory isolation │ Session isolation │ Per-group folders │ Single namespace │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Crash recovery cursors │ No │ Two-cursor system │ Absurd checkpointing │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Codebase token budget tracking │ No │ repo-tokens CI badge │ No │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼────────────────────────┤
│ Image/media handling │ Yes │ Yes │ Text-only │
└────────────────────────────────────────────────┴───────────────────────┴──────────────────────┴────────────────────────┘

Top Opportunities (ordered by impact vs effort)

1. More Channels — The adapter interface is already there. WhatsApp (via Baileys like NanoClaw) and Discord would cover the most users. Low architectural risk.

2. MCP Server Support — OpenClaw's MCP integration gives access to thousands of community tools. Adding MCP client support to everclaw's tool registry would massively
   expand capabilities without writing custom tools. Medium effort.

3. Multi-modal Messages (images/voice) — Both ecosystems handle images. The InboundMessage type is text-only today. Adding media would unlock vision use cases.

4. Agent Swarms / Parallel Execution — NanoClaw's killer feature. Currently spawn_task is fire-and-forget. Adding a spawn_and_collect pattern that fans out multiple agents
   and merges results would enable complex workflows.

5. Persistent Personality / Identity — OpenClaw's SOUL.md concept. Everclaw has data/notes/ but no structured personality file that shapes all interactions. A dedicated
   identity document could improve consistency.

6. Container Isolation — NanoClaw's core differentiator. Running tool scripts inside containers rather than on the host would dramatically improve security. Relevant since
   everclaw already runs scripts with execFile.

7. Multi-LLM Provider Support — OpenClaw supports Anthropic, OpenAI, Gemini, Ollama. Adding provider abstraction would let users choose their model. Lower priority since
   Claude is excellent, but useful for cost/privacy tradeoffs.

8. Per-user Memory Isolation — Both ecosystems isolate context per user/group. Everclaw's state store is namespaced but conversation history is already per-recipient. Could
   formalize this with per-user skill state.

9. Browser Automation — OpenClaw can control browsers. Adding a Playwright-based tool would enable web scraping, form filling, and monitoring workflows.

10. Skill Sharing / Registry — OpenClaw has ClawHub with 13K+ skills. Even a simple git-based skill import mechanism would help everclaw users share and reuse skills.

The biggest architectural advantages everclaw has over both — durable workflows with checkpointing and event coordination — are genuinely unique. Neither NanoClaw nor
OpenClaw has anything comparable to sleep_until + wait_for_event + durable replay. That's worth leaning into.
