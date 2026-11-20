# Pi RPC subagents

Run a background Pi child per assignment without holding the parent tool call open. Each child keeps its own Pi conversation and can ask its parent questions over RPC.

## Try locally

Requires Linux with `flock`, Node 22, and Pi 1.5.2. Launch the parent from the project you want the child to work in:

```sh
pi -e /home/alex/Repos/pi-rpc-subagents/extension.ts
# Reopen the parent without launching any child:
pi --continue -e /home/alex/Repos/pi-rpc-subagents/extension.ts
```

Use `/subagents start <assignment>` to get a child ID, then `/subagents list` and `/subagents status <id>` for its state, last result, and any question ID. The parent model can also use `rpc_subagent`. A prompt acknowledgement is not completion or proof the model has read it. If a prompt is not acknowledged, the plugin stops that child. Inspect its transcript before explicitly resuming; the prompt will not be replayed.

| Command arguments after `/subagents` | Behavior |
| --- | --- |
| `send <id> <message>` | New turn when idle; steering when busy. It does not interrupt a tool. |
| `wait <id>` | Wait at most five seconds; return immediately on `needs_reply`. |
| `answer <id> <question-id> <answer>` | Resolve only the matching live `ask_parent` dialog. |
| `pause <id>` | Close idle children gracefully; clear queued work and abort active work before bounded termination. Does not revert file changes. |
| `archive <id>` / `unarchive <id>` | Hide a paused child from `list`, or make it visible again. Neither deletes history nor starts a process. `all` includes archives. |
| `resume <id> <instruction>` | Reopen the exact child transcript with explicit new instructions. |
| `resume <id> q=<question-id> <answer>` | Answer a recovered question as new input, never as a reply to the old RPC dialog. |

## Persistence and boundaries

- A saved parent session is required. Registry, locks, and child JSONL are under `PI_CODING_AGENT_DIR/rpc-subagents/<parent-session-id>/` (normally `~/.pi/agent/rpc-subagents/`). The per-parent registry is independent of `/tree`; a new or forked session has its own registry. Restoration only lists state; it does not launch children, replay inputs, or retry tools.
- A live child can be `idle` with a process still running. `paused` denotes a stopped child. If a prior process group or writer cannot be ruled out, `interrupted` blocks resume until cleanup can be confirmed. A missing transcript is an error, not permission to start a fresh child.
- Up to four live children, sharing the current workspace and inheriting the selected model and thinking level. Default tools are `read`, `grep`, `find`, `ls`, and `ask_parent`. `start-write <assignment>` explicitly asks the user to allow `edit` and `write`. There is no shell, MCP, or project extension in the child. This is a tool allowlist, not a filesystem sandbox. Do not delegate work that would expose secrets or bypass project policy.
- This is the standalone transport and lifecycle implementation. Trellis role definitions, task-context injection and its existing synchronous callers are not yet integrated. There is no detached supervisor or automatic workspace isolation.

`npm test` exercises real Pi 1.5.2 processes against a loopback mock provider. Set `PI_BIN` if Pi is not at `~/.pi/agent/bin/pi`.
