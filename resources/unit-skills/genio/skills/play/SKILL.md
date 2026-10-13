---
name: play
description: Lease a shared Unity Play slot and control only that copy through Pipeline.
---

# Shared Unity Play

Never target the world's main editor or its Library/Pipeline credentials. This is a guardrail, not an OS sandbox. Never touch Toolbox, its processes or packages.

Commit the branch state to test first. Start a long-lived session:

`node "{{SKILL_DIR}}/scripts/play.mjs" --open`

The helper uses the Genio-provided environment, waits FIFO for a shared slot, seeds its Library once, and renews its lease while stdin stays open. It only copies committed files from this unit's registered repository. The cap defaults to one; only the player's Play screen configures it. It refuses branch changes while a slot editor is open or its checkout has local changes. Do not delete those changes to continue.

Wait for the ready record and Unity import. Send one JSON object per line, for example:

```json
{"id":"1","command":"editor_status"}
{"id":"2","command":"editor_play"}
{"id":"3","command":"capture_game_view","parameters":{"width":1280,"height":720,"source":"screen"}}
{"id":"4","command":"console","parameters":{"tail":100}}
{"id":"5","command":"editor_stop"}
{"command":"exit"}
```

Pipeline commands including input and run_tests target only the leased slot. Use command discovery for parameter schemas. Keep this process alive for the whole test; EOF releases the lease. Stop immediately on lease loss: the player can take over. The helper closes in-flight HTTP on lease loss, but Unity work already executing cannot be revoked. Do not run a second uncontrolled CLI session. Never launch on the main copy.

Screenshots are returned as base64; save reports and decoded images in the task's scratch data, never the world. If a transaction lock survives a crashed process, report its path to Genio; never remove shared pool state yourself. No stream package installation or main-world writes are authorized by this skill.
