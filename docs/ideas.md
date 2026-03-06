┌────────────────────────────────────────────────┬───────────────────────┬──────────────────────┬──────────────────────────────┐
│ Feature                                        │ OpenClaw              │ NanoClaw             │ Everclaw                     │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Multi-channel (WhatsApp, Discord, Slack, etc.) │ 20+ channels          │ 5 channels           │ 5 channels                   │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Multi-LLM support (OpenAI, Gemini, local)      │ Yes                   │ Claude-only          │ Claude-only                  │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Container isolation for agent execution        │ No                    │ Core feature         │ No                           │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ MCP server integration                         │ Yes (13K+ servers)    │ Via Claude Agent SDK │ Yes (stdio, dynamic reload)  │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Persistent personality (SOUL.md)               │ Yes                   │ Per-group CLAUDE.md  │ Pinned notes (data/notes/pinned/) │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Skill registry / sharing                       │ ClawHub (13K+ skills) │ Fork-and-transform   │ Local only                   │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Agent swarms (parallel agents on one task)      │ No                    │ Yes                  │ No (serial spawn_workflow)   │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Per-group/per-user memory isolation            │ Session isolation      │ Per-group folders    │ History per-chatId, notes shared │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Crash recovery cursors                         │ No                    │ Two-cursor system    │ Absurd checkpointing         │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Codebase token budget tracking                 │ No                    │ repo-tokens CI badge │ No                           │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Image/media handling                           │ Yes                   │ Yes                  │ Voice transcription (Whisper) │
├────────────────────────────────────────────────┼───────────────────────┼──────────────────────┼──────────────────────────────┤
│ Browser automation                             │ No                    │ No                   │ Yes (agent-browser)          │
└────────────────────────────────────────────────┴───────────────────────┴──────────────────────┴──────────────────────────────┘

Remaining Opportunities (ordered by impact vs effort)

1. Image/Media Messages — Voice works via Whisper, but images are still dropped. Adding image support to InboundMessage and forwarding to Claude's
   vision API would unlock screenshot analysis, photo-based tasks, etc. Medium effort — adapter changes + API message format.

2. Agent Swarms / Parallel Execution — spawn_workflow is fire-and-forget. A spawn_and_collect pattern that fans out multiple agents and merges
   results would enable complex workflows (e.g. research 5 topics in parallel, combine findings). Medium effort.

3. Container Isolation — Running tool scripts inside containers rather than on the host would dramatically improve security. Relevant since
   everclaw runs scripts with execFile and has browser automation. Medium-high effort.

4. Per-user Memory Isolation — Conversation history is already per-chatId, but notes, skills, and scripts are shared across all users. Formalizing
   per-user state would matter for multi-user deployments. Medium effort.

5. Multi-LLM Provider Support — Adding provider abstraction would let users choose their model (OpenAI, Gemini, Ollama). Lower priority since
   Claude is excellent, but useful for cost/privacy tradeoffs.

6. Skill Sharing / Registry — Even a simple git-based skill import mechanism would help users share and reuse skills across instances.

The biggest architectural advantages everclaw has over both — durable workflows with checkpointing and event coordination — are genuinely unique. Neither NanoClaw nor
OpenClaw has anything comparable to sleep_until + wait_for_event + durable replay. That's worth leaning into.
