import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pi = process.env.PI_BIN ?? join(homedir(), ".pi/agent/bin/pi");
const extension = fileURLToPath(new URL("./extension.ts", import.meta.url));

test("Pi RPC: background questions, stop/archive, exact transcript recovery, no replay", { timeout: 35_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-rpc-subagents-"));
  const agent = join(tmp, "agent");
  const cwd = join(tmp, "work");
  await mkdir(agent);
  await mkdir(cwd);
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push(data);
    const last = data.messages.at(-1);
    const user = data.messages.findLast(m => m.role === "user");
    const text = JSON.stringify(user?.content);
    const tool = (id, question) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name: "ask_parent", arguments: JSON.stringify({ question }) } }] });
    let delta;
    if (last.role === "tool" && last.tool_call_id === "call_one") delta = tool("call_two", "Which label?");
    else if (last.role === "tool" && last.tool_call_id === "call_two") delta = { content: "Done with both replies." };
    else if (text?.includes("Explicit parent answer")) delta = { content: "Recovered from saved question." };
    else if (text?.includes("Inspect prior answers")) delta = { content: "Read old answers." };
    else if (text?.includes("Ask before crash")) delta = tool("call_crash", "What to recover?");
    else if (text?.includes("Ask two questions")) delta = tool("call_one", "Which version?");
    else delta = { content: "Parent is responsive." };
    const payload = (delta, finish_reason) => JSON.stringify({ id: `mock_${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${payload({ role: "assistant", ...delta }, null)}\n\ndata: ${payload({}, delta.tool_calls ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const parents = [];
  try {
    await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "test", name: "test", contextWindow: 32_000, maxTokens: 4096 }] } } }));
    function parent(extra = []) {
      const child = spawn(pi, ["--offline", "--no-approve", "--no-mcp", "--no-extensions", "--no-skills", "--no-context-files", "--mode", "rpc", "--model", "mock/test", "--thinking", "off", "-e", extension, ...extra],
        { cwd, env: { HOME: homedir(), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0" } });
      const closed = once(child, "close");
      parents.push({ child, closed });
      const events = [];
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
      createInterface({ input: child.stdout }).on("line", line => { try { events.push(JSON.parse(line)); } catch { stderr += line; } });
      async function find(pred, start = 0) {
        for (let i = 0; i < 240; i++) {
          const found = events.slice(start).find(pred);
          if (found) return found;
          if (child.exitCode !== null) break;
          await delay(25);
        }
        assert.fail(`Missing event after ${start}: ${JSON.stringify(events.slice(start).filter(e => ["response", "extension_ui_request"].includes(e.type)))} ${stderr}`);
      }
      let sequence = 0;
      async function rpc(type, fields = {}) {
        const id = String(++sequence);
        child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
        const e = await find(e => e.type === "response" && e.id === id);
        assert.ok(e.success, e.error);
        return e.data;
      }
      async function command(args) {
        const start = events.length;
        await rpc("prompt", { message: `/subagents ${args}` });
        const e = events.slice(start).filter(e => e.type === "extension_ui_request" && e.method === "notify" && !e.message.startsWith("Background subagent ")).at(-1);
        assert.ok(e, `No command result for ${args}`);
        return e.message;
      }
      return { child, closed, events, find, rpc, command };
    }
    let p = parent();
    await p.rpc("prompt", { message: "Initialize the parent history." });
    await p.find(e => e.type === "agent_settled");
    const state = await p.rpc("get_state");
    const created = await p.command("start Ask two questions");
    assert.match(created, /^Subagent [a-f0-9-]+: prompt accepted/);
    const id = created.split(" ")[1].slice(0, -1);
    async function status(expected, questionId) {
      for (let i = 0; i < 50; i++) {
        const w = JSON.parse(await p.command(`status ${id}`));
        if (w.state === expected && (!questionId || w.question?.id === questionId)) return w;
        await delay(30);
      }
      assert.fail(`Subagent did not reach ${expected} ${questionId ?? ""}.`);
    }
    const first = await status("needs_reply", "call_one");
    const nested = requests.at(-1).tools.map(t => t.function.name).sort();
    assert.deepEqual(nested, ["ask_parent", "find", "grep", "ls", "read"]);
    const eventIndex = p.events.length;
    await p.rpc("prompt", { message: "Parent can take another turn now." });
    await p.find(e => e.type === "agent_settled", eventIndex);
    assert.match(await p.command(`answer ${id} stale Wrong`), /No matching live question/);
    assert.equal(JSON.parse(await p.command(`wait ${id}`)).state, "needs_reply");
    assert.match(await p.command(`answer ${id} call_one Alpha`), /Reply sent/);
    await status("needs_reply", "call_two");
    assert.match(await p.command(`answer ${id} call_two Beta`), /Reply sent/);
    const done = await status("idle");
    assert.match(done.result, /both replies/);
    assert.equal(done.question, undefined);
    const duplicate = parent(["--session", state.sessionFile]);
    assert.match(await duplicate.command("list"), /already open/);
    duplicate.child.stdin.end();
    await duplicate.closed;
    assert.match(await p.command(`pause ${id}`), /: paused\./);
    assert.match(await p.command(`archive ${id}`), /history kept/);
    assert.equal(await p.command("list"), "No subagents.");
    assert.match(await p.command("all"), /archived/);
    p.child.stdin.end();
    await p.closed;
    const beforeRestore = requests.length;
    p = parent(["--continue"]);
    assert.match(await p.command("all"), /archived/);
    assert.match(await p.command(`unarchive ${id}`), /no process started/);
    assert.equal(requests.length, beforeRestore);
    assert.match(await p.command(`resume ${id} Inspect prior answers`), /prompt accepted/);
    const resumed = await status("idle");
    assert.deepEqual(resumed.session, first.session);
    const prior = JSON.stringify(requests.at(-1).messages);
    assert.match(prior, /Alpha/);
    assert.match(prior, /Beta/);
    await p.command(`send ${id} Ask before crash`);
    await status("needs_reply", "call_crash");
    p.child.kill("SIGKILL");
    await p.closed;
    const crashRequests = requests.length;
    p = parent(["--continue"]);
    for (let i = 0; i < 100; i++) {
      const list = await p.command("list");
      if (list.includes("paused") || list.includes("interrupted")) break;
      assert.match(list, /already open/);
      await delay(30);
    }
    const restored = JSON.parse(await p.command(`status ${id}`));
    assert.equal(restored.question.id, "call_crash");
    assert.equal(restored.question.delivery, "uncertain");
    assert.equal(requests.length, crashRequests);
    assert.match(await p.command(`answer ${id} call_crash stale`), /live child/);
    const recovery = await p.command(`resume ${id} q=call_crash Recover explicitly`);
    if (restored.state === "interrupted" && recovery.includes("stopped child")) {
      // Some container PID 1 implementations do not reap orphaned groups; fail closed.
      assert.equal(requests.length, crashRequests);
    } else {
      assert.match(recovery, /prompt accepted/);
      assert.match((await status("idle")).result, /saved question/);
    }
  } finally {
    for (const { child, closed } of parents) {
      if (!child.stdin.destroyed) child.stdin.end();
      const forced = setTimeout(() => child.kill("SIGKILL"), 2500).unref();
      await closed;
      clearTimeout(forced);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
