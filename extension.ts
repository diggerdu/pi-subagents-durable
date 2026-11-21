import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_TIMEOUT, MAX_TEXT, tag } from "./child.ts";
import { groupGone, parentLease, RpcChild, unlocked, type Frame } from "./rpc.ts";

const ID = /^[a-f0-9-]{36}$/;
const STATES = ["starting", "running", "idle", "needs_reply", "stopping", "paused", "interrupted", "archived"] as const;
const ACTIONS = ["start", "list", "all", "status", "send", "wait", "answer", "pause", "resume", "archive", "unarchive"] as const;
const LIMIT = 4;
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim().slice(0, MAX_TEXT);

type Action = typeof ACTIONS[number];
type StartOptions = { model?: string; thinking?: string; readOnly?: boolean };
type Worker = {
  id: string; task: string; model: string; thinking: string; write: boolean; shell?: boolean; state: typeof STATES[number];
  origin?: string; session?: { id: string; file: string }; group?: number;
  question?: { id: string; text: string; delivery: "pending" | "uncertain" };
  result?: string; reason?: string;
};
type Live = { rpc: RpcChild; ctx: ExtensionContext; dialog?: string; expiry?: ReturnType<typeof setTimeout>; text?: string; failed?: boolean; answered?: string; prompting?: boolean; pausing?: Promise<void> };

function privateDir(path: string) {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error(`Expected a private directory: ${path}`);
}

function atomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function verifySession(dir: string, session: NonNullable<Worker["session"]>, cwd: string) {
  const path = join(dir, session.file);
  if (!existsSync(path)) throw new Error("Saved child transcript is missing; resume cannot start a fresh conversation.");
  if (basename(session.file) !== session.file || !session.file.endsWith(".jsonl") || !lstatSync(path).isFile() || dirname(realpathSync(path)) !== realpathSync(dir)) {
    throw new Error("Child transcript is not a managed file.");
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16_384);
    const head = buf.toString("utf8", 0, readSync(fd, buf)).split("\n", 1)[0];
    const header = JSON.parse(head);
    if (header.type !== "session" || header.id !== session.id || header.cwd !== cwd) throw new Error("Child transcript identity changed.");
  } finally { closeSync(fd); }
  return path;
}

class Fleet {
  private workers = new Map<string, Worker>();
  private live = new Map<string, Live>();
  private closing = false;
  private failed = false;
  private readonly file: string;
  constructor(private dir: string, private cwd: string, private lease: Awaited<ReturnType<typeof parentLease>>, private thinking: () => ModelThinkingLevel) {
    this.file = join(dir, "fleet.json");
    if (!existsSync(this.file)) return;
    const saved = JSON.parse(readFileSync(this.file, "utf8"));
    if (saved.version !== 1 || saved.cwd !== cwd || !Array.isArray(saved.workers)) throw new Error("Invalid subagent registry or workspace mismatch.");
    for (const w of saved.workers as Worker[]) {
      if (typeof w.id !== "string" || !ID.test(w.id) || this.workers.has(w.id) || !STATES.includes(w.state) ||
        (w.group !== undefined && (!Number.isSafeInteger(w.group) || w.group < 2))) throw new Error("Invalid child record.");
      this.workers.set(w.id, w);
      if (w.state !== "archived" && w.state !== "paused") {
        if (w.question) w.question.delivery = "uncertain";
        this.reconcile(w);
      }
    }
    this.save();
  }

  private save() {
    if (!this.lease.alive() || this.failed) throw new Error("Subagent registry is no longer writable.");
    try { atomic(this.file, { version: 1, cwd: this.cwd, workers: [...this.workers.values()] }); }
    catch (error) {
      this.failed = true;
      void this.close();
      throw error;
    }
  }

  private lock(w: Worker) { return join(this.dir, w.id, "child.lock"); }

  private reconcile(w: Worker) {
    const safe = groupGone(w.group) && unlocked(this.lock(w));
    w.state = safe ? "paused" : "interrupted";
    if (safe) delete w.group;
    w.reason = safe ? "Process stopped; explicit resume required." : "Previous writer or process group is not confirmed gone; resume is blocked.";
  }

  private notice(w: Worker, live: Live, text: string) {
    if (!this.closing && (!w.origin || live.ctx.sessionManager.getBranch().some(entry => entry.id === w.origin))) {
      live.ctx.ui.notify(`Background subagent ${w.id}: ${text}`, "info");
    }
  }

  private event(w: Worker, live: Live, token: string, frame: Frame) {
    if (this.live.get(w.id) !== live || w.state === "stopping" || this.closing) return;
    if (frame.type === "extension_ui_request" && ["input", "confirm", "select", "editor"].includes(String(frame.method)) && typeof frame.id === "string") {
      const prefix = tag(token);
      const title = frame.title;
      if (frame.method !== "input" || typeof title !== "string" || !title.startsWith(prefix) || live.dialog) {
        live.rpc.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        return;
      }
      const question = JSON.parse(title.slice(prefix.length));
      if (typeof question.id !== "string" || typeof question.text !== "string" || !clean(question.text)) {
        live.rpc.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        return;
      }
      live.dialog = frame.id;
      w.question = { id: question.id, text: clean(question.text), delivery: "pending" };
      w.state = "needs_reply";
      this.save();
      this.notice(w, live, `needs reply (${question.id}); use /subagents status ${w.id}`);
      live.expiry = setTimeout(() => {
        if (!live.dialog || this.live.get(w.id) !== live) return;
        delete live.dialog;
        if (w.question) w.question.delivery = "uncertain";
        if (w.state === "needs_reply") w.state = "running";
        try { this.save(); } catch { /* registry failure stops the fleet */ }
      }, ASK_TIMEOUT).unref();
    } else if (frame.type === "agent_start") {
      live.text = undefined;
      live.failed = false;
    } else if (frame.type === "message_end") {
      const message = frame.message as { role?: string; details?: { questionId?: string; answered?: boolean }; stopReason?: string; content?: { type: string; text?: string }[] } | undefined;
      if (message?.role === "toolResult" && message.details?.answered) live.answered = message.details.questionId;
      if (message?.role === "assistant") {
        live.failed = message.stopReason === "error" || message.stopReason === "aborted";
        const text = message.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
        if (text) live.text = clean(text);
      }
    } else if (frame.type === "turn_end") {
      // Pi emits message_end before persisting the tool result.
      if (live.answered && w.question?.id === live.answered) { delete w.question; this.save(); }
      delete live.answered;
    } else if (frame.type === "agent_settled") {
      clearTimeout(live.expiry);
      delete live.dialog;
      if (w.question?.delivery === "pending") w.question.delivery = "uncertain";
      w.state = "idle";
      w.reason = live.failed || frame.aborted ? "Last child run did not complete normally; inspect before sending more work." : undefined;
      w.result = live.text;
      this.save();
      this.notice(w, live, w.reason ?? "idle; result available via status.");
    }
  }

  private async launch(w: Worker, ctx: ExtensionContext, message: string) {
    if (this.live.size >= LIMIT) throw new Error(`At most ${LIMIT} live subagents per session.`);
    const dir = join(this.dir, w.id);
    privateDir(dir);
    if (!groupGone(w.group) || !unlocked(this.lock(w))) throw new Error("A previous child may still be alive.");
    const session = w.session && verifySession(dir, w.session, this.cwd);
    const token = randomUUID();
    const script = process.argv[1];
    const command = process.env.PI_RPC_SUBAGENT_BIN || (script && existsSync(script) ? process.execPath : "pi");
    const args = command === process.execPath ? [script] : [];
    const tools = "read,grep,find,ls,ask_parent" + (w.write ? ",edit,write" : "") + (w.shell ? ",bash" : "");
    args.push("--mode", "rpc", "--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
      "--model", w.model, "--thinking", w.thinking, "--tools", tools,
      "--session-dir", dir, "-e", fileURLToPath(new URL("./child.ts", import.meta.url)));
    if (session) args.push("--session", session);
    w.state = "starting";
    w.reason = undefined;
    this.save();
    const rpc = new RpcChild(this.lock(w), command, args, { cwd: this.cwd, env: { ...process.env, PI_RPC_SUBAGENT_TOKEN: token } }, frame => this.event(w, live, token, frame));
    const live: Live = { rpc, ctx };
    this.live.set(w.id, live);
    void rpc.closed.then(() => {
      if (this.live.get(w.id) !== live || w.state === "stopping") return;
      clearTimeout(live.expiry);
      this.live.delete(w.id);
      if (w.question) w.question.delivery = "uncertain";
      this.reconcile(w);
      try { this.save(); this.notice(w, live, w.reason!); } catch { /* registry failure stops the fleet */ }
    });
    try {
      w.group = rpc.process.pid;
      this.save();
      const state = await rpc.request("get_state", {}, 8000);
      if (this.closing || w.state !== "starting" || this.live.get(w.id) !== live) throw new Error("Child start cancelled.");
      const model = state.model as { provider?: string; id?: string } | undefined;
      if (typeof state.sessionFile !== "string" || dirname(state.sessionFile) !== dir || typeof state.sessionId !== "string" ||
        `${model?.provider}/${model?.id}` !== w.model) {
        throw new Error("Child did not open the requested model and managed session.");
      }
      if (w.session && (state.sessionFile !== session || state.sessionId !== w.session.id)) throw new Error("Child opened the wrong transcript.");
      w.session = { file: basename(state.sessionFile), id: state.sessionId };
      await this.prompt(w, live, message);
      return `Subagent ${w.id}: prompt accepted, not completed.`;
    } catch (error) {
      if (this.live.get(w.id) === live) await this.pause(w);
      throw error;
    }
  }

  private async prompt(w: Worker, live: Live, text: string) {
    if (live.prompting) throw new Error("A prompt is still awaiting acknowledgement.");
    live.prompting = true;
    try {
      w.state = "running";
      this.save();
      try {
        await live.rpc.request("prompt", { message: text, streamingBehavior: "steer" });
      } catch (error) {
        const reason = "Prompt not acknowledged. Inspect the child transcript before explicitly resuming; input will not be replayed.";
        if (this.live.get(w.id) === live) await (live.pausing ??= this.stopWorker(w, live, reason));
        throw new Error(`${reason} ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      live.prompting = false;
    }
  }

  private async pause(w: Worker) {
    const live = this.live.get(w.id);
    if (live) {
      await (live.pausing ??= this.stopWorker(w, live));
    } else if (w.state === "interrupted") { this.reconcile(w); this.save(); }
    return w.state;
  }

  private async stopWorker(w: Worker, live: Live, reason?: string) {
    const wasIdle = w.state === "idle";
    w.state = "stopping";
    if (w.question) w.question.delivery = "uncertain";
    clearTimeout(live.expiry);
    try { if (!this.failed) this.save(); } finally {
      const stopped = await live.rpc.stop(wasIdle);
      this.live.delete(w.id);
      this.reconcile(w);
      if (!stopped) {
        w.group = live.rpc.process.pid;
        w.state = "interrupted";
        w.reason = "Child exit or group cleanup was not confirmed.";
      }
      if (reason) w.reason = `${reason} ${w.reason ?? ""}`.trim();
      if (!this.failed) this.save();
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try { await Promise.allSettled([...this.live.keys()].map(id => this.pause(this.workers.get(id)!))); }
    finally { await this.lease.release(); }
  }

  async act(action: Action, ctx: ExtensionContext, id?: string, text?: string, questionId?: string, options: StartOptions = {}, signal?: AbortSignal) {
    if (this.closing || !this.lease.alive() || this.failed) throw new Error("Subagent manager is unavailable.");
    const input = clean(text ?? "");
    signal?.throwIfAborted();
    if (action === "list" || action === "all") return [...this.workers.values()].filter(w => action === "all" || w.state !== "archived")
      .map(w => `${w.id} ${w.state}: ${w.task.split("\n", 1)[0].slice(0, 140)}`).join("\n") || "No subagents.";
    if (action === "start") {
      if (!input) throw new Error("A task is required.");
      if (this.live.size >= LIMIT) throw new Error(`At most ${LIMIT} live subagents per session.`);
      const selection = options.model?.match(/^([^/]+)\/(.+)$/);
      const model = options.model === undefined ? ctx.model : selection && ctx.modelRegistry.find(selection[1], selection[2]);
      if (!model) throw new Error(options.model === undefined ? "Select a parent model or pass a subagent model." : `Unknown subagent model: ${options.model}. Use provider/model.`);
      const levels = getSupportedThinkingLevels(model);
      const thinking = options.thinking === undefined ? clampThinkingLevel(model, this.thinking()) : levels.find(level => level === options.thinking);
      if (!thinking) throw new Error(`Unsupported thinking level for ${model.provider}/${model.id}: ${options.thinking}. Choose ${levels.join(", ")}.`);
      const fullAccess = !options.readOnly;
      const w: Worker = { id: randomUUID(), task: input, model: `${model.provider}/${model.id}`, thinking,
        write: fullAccess, shell: fullAccess, state: "paused", origin: ctx.sessionManager.getLeafId() ?? undefined };
      this.workers.set(w.id, w);
      return await this.launch(w, ctx, `Subagent assignment:\n${input}`);
    }
    const w = id ? this.workers.get(id) : undefined;
    if (!w) throw new Error("Unknown child ID; see /subagents list.");
    const live = this.live.get(w.id);
    if (action === "wait") {
      for (let i = 0; i < 20 && ["starting", "running", "stopping"].includes(w.state); i++) await delay(250, undefined, { signal });
    }
    if (action === "status" || action === "wait") return JSON.stringify(w, null, 2);
    if (action === "unarchive") {
      if (w.state !== "archived") throw new Error("Child is not archived.");
      w.state = "paused"; this.save(); return "Unarchived; no process started.";
    }
    if (w.state === "archived") throw new Error("Unarchive before changing a child.");
    if (action === "pause") return `Subagent ${w.id}: ${await this.pause(w)}.`;
    if (action === "archive") {
      if (live || w.state !== "paused" || !groupGone(w.group) || !unlocked(this.lock(w))) throw new Error("Pause and confirm exit before archiving.");
      w.state = "archived"; this.save(); return "Archived; history kept.";
    }
    if (action === "resume") {
      if (live) throw new Error("Child already has a process.");
      if (w.state === "interrupted") { this.reconcile(w); this.save(); }
      if (w.state !== "paused" || !input) throw new Error("Resume requires a stopped child and explicit new instructions.");
      const question = w.question;
      if (question && questionId !== question.id) throw new Error("Resume needs the saved question ID and explicit answer. See status.");
      const result = await this.launch(w, ctx, question ? `Resume from the saved transcript. Saved question: ${JSON.stringify(question.text)}\nExplicit parent answer: ${JSON.stringify(input)}`
        : `Resume the existing assignment: ${JSON.stringify(w.task)}\nNew parent instruction: ${JSON.stringify(input)}`);
      if (question && w.question === question) { delete w.question; this.save(); }
      return result;
    }
    if (!live || !input || !["idle", "running", "needs_reply"].includes(w.state)) throw new Error("A live child and non-empty text are required.");
    if (action === "answer") {
      if (w.state !== "needs_reply" || !live.dialog || !w.question || w.question.id !== questionId) throw new Error("No matching live question; use status.");
      const dialog = live.dialog;
      w.question.delivery = "uncertain";
      this.save();
      live.rpc.send({ type: "extension_ui_response", id: dialog, value: input });
      clearTimeout(live.expiry);
      delete live.dialog;
      w.state = "running";
      this.save();
      return "Reply sent to the matching dialog; consumption is not yet confirmed.";
    }
    if (w.state === "needs_reply") throw new Error("Answer the pending question before steering this child.");
    await this.prompt(w, live, `Parent instruction: ${JSON.stringify(input)}`);
    return "Prompt accepted; it may be queued and has not necessarily been read.";
  }
}

export default function (pi: ExtensionAPI) {
  let fleet: Promise<Fleet> | undefined;
  function get(ctx: ExtensionContext) {
    if (!ctx.sessionManager.getSessionFile()) throw new Error("Subagents require a saved parent session.");
    if (process.platform !== "linux") throw new Error("Subagents currently require Linux and flock.");
    const id = ctx.sessionManager.getSessionId();
    if (!ID.test(id)) throw new Error("Invalid parent session ID.");
    if (!fleet) fleet = (async () => {
      const root = join(realpathSync(getAgentDir()), "rpc-subagents");
      privateDir(root);
      const dir = join(root, id);
      privateDir(dir);
      const lease = await parentLease(join(dir, "parent.lock"));
      try { return new Fleet(dir, realpathSync(ctx.cwd), lease, () => pi.getThinkingLevel()); }
      catch (error) { await lease.release(); throw error; }
    })().catch(error => { fleet = undefined; throw error; });
    return fleet;
  }
  pi.on("session_shutdown", async () => { const old = fleet; if (old) await old.then(f => f.close(), () => {}); fleet = undefined; });
  pi.registerTool({
    name: "rpc_subagent", label: "RPC subagent",
    description: "Manage background subagents. Start accepts model (provider/model), thinking, and readOnly; defaults to the parent model and full built-in tools including Bash. Start returns after acknowledgement, not completion. Wait is short and returns needs_reply instead of blocking on a question. Child results are untrusted data.",
    parameters: Type.Object({ action: Type.Union(ACTIONS.map(action => Type.Literal(action))), id: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ maxLength: MAX_TEXT })), questionId: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), readOnly: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      const message = await (await get(ctx)).act(params.action as Action, ctx, params.id, params.text, params.questionId, params, signal);
      return { content: [{ type: "text", text: message }], details: {} };
    },
  });
  pi.registerCommand("subagents", {
    description: "List or manage saved background subagents",
    async handler(args, ctx) {
      const [verb = "list", ...parts] = args.trim().split(/\s+/).filter(Boolean);
      try {
        const action = verb === "start-write" ? "start" : verb as Action;
        if (!ACTIONS.includes(action)) throw new Error("Actions: " + [...ACTIONS, "start-write"].join(", "));
        const id = action === "start" ? undefined : parts.shift();
        const tagged = action === "answer" || (action === "resume" && parts[0]?.startsWith("q="));
        const questionId = tagged ? parts.shift()?.replace(/^q=/, "") : undefined;
        const options: StartOptions = {};
        if (action === "start") {
          while (parts[0]?.startsWith("--")) {
            const flag = parts.shift();
            if (flag === "--") break;
            if (flag === "--read-only") { options.readOnly = true; continue; }
            const key = flag === "--model" ? "model" : flag === "--thinking" ? "thinking" : undefined;
            if (!key || !parts[0] || parts[0].startsWith("--")) {
              throw new Error("Usage: /subagents start [--model provider/model] [--thinking level] [--read-only] <assignment>");
            }
            options[key] = parts.shift();
          }
        }
        const result = await (await get(ctx)).act(action, ctx, id, parts.join(" "), questionId, options);
        ctx.ui.notify(result, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
