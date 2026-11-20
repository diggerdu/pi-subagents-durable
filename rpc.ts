import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type Frame = Record<string, unknown>;

export function unlocked(path: string) {
  const result = spawnSync("flock", ["-n", path, "true"], { timeout: 1000 });
  return !result.error && result.status === 0;
}

export function groupGone(pid?: number) {
  if (!pid) return true;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function parentLease(path: string) {
  const child = spawn("flock", ["-n", "-F", path, process.execPath, "-e",
    "process.stdin.resume();process.stdout.write('locked\\n');"], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  let exit!: () => void;
  const closed = new Promise<void>(resolve => { exit = resolve; });
  child.once("close", exit);
  const ready = new Promise<boolean>(resolve => {
    child.once("error", () => resolve(false));
    child.once("close", () => resolve(false));
    child.stdout.once("data", () => resolve(true));
  });
  if (!await Promise.race([ready, delay(2000, false, { ref: false })])) {
    child.kill("SIGKILL");
    await closed;
    throw new Error("This parent session is already open, or flock is unavailable.");
  }
  return {
    alive: () => child.exitCode === null && child.signalCode === null,
    async release() { child.stdin.end(); await closed; },
  };
}

export class RpcChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, { done: (frame: Frame) => void; fail: (error: Error) => void }>();
  private sequence = 0;
  private ended = false;
  private stopping?: Promise<boolean>;

  constructor(lock: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, onEvent: (frame: Frame) => void) {
    const proc = this.process = spawn("flock", ["-n", "-F", lock, command, ...args], { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const fail = (error: Error) => {
      this.ended = true;
      for (const request of this.pending.values()) request.fail(error);
    };
    this.closed = new Promise(resolve => proc.once("close", () => {
      fail(new Error("Child RPC closed."));
      resolve();
    }));
    proc.on("error", fail);
    proc.stdin.on("error", fail);
    proc.stderr.resume();
    proc.stdout.once("end", () => {
      fail(new Error("Child RPC reached EOF."));
      void this.stop();
    });
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.ended) return;
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop()!;
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.length > 8_000_000) throw new Error("Oversized child RPC frame.");
          const frame: Frame = JSON.parse(line);
          if (!frame || typeof frame.type !== "string") throw new Error("Invalid child RPC frame.");
          if (frame.type === "response") this.pending.get(String(frame.id))?.done(frame);
          else onEvent(frame);
        }
        if (buffer.length > 8_000_000) throw new Error("Oversized child RPC frame.");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        void this.stop();
      }
    });
  }

  send(frame: Frame) {
    if (this.ended || this.process.stdin.destroyed) throw new Error("Child RPC is closed.");
    if (this.process.stdin.writableLength > 128_000) throw new Error("Child RPC input is backed up.");
    this.process.stdin.write(JSON.stringify(frame) + "\n");
  }

  request(type: string, fields: Frame = {}, timeout = 5000): Promise<Frame> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 16) { reject(new Error("Too many pending RPC commands.")); return; }
      const cleanup = () => { clearTimeout(timer); this.pending.delete(id); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error(`${type} did not acknowledge; delivery is uncertain.`)), timeout);
      this.pending.set(id, { fail, done: frame => {
        cleanup();
        if (frame.success !== true) reject(new Error(String(frame.error ?? "RPC command failed.")));
        else resolve((frame.data ?? {}) as Frame);
      } });
      try { this.send({ type, id, ...fields }); }
      catch (error) { fail(error as Error); }
    });
  }

  stop(idle = false) {
    return this.stopping ??= this.stopOnce(idle);
  }

  private async stopOnce(idle: boolean) {
    const { process: proc } = this;
    const signal = (value: NodeJS.Signals) => {
      if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
      try { process.kill(-proc.pid, value); } catch { /* exit may win the race */ }
    };
    if (!idle && !this.ended) {
      await this.request("clear_queue", {}, 350).catch(() => {});
      await this.request("abort", {}, 600).catch(() => {});
    }
    proc.stdin.end();
    await Promise.race([this.closed, delay(350)]);
    signal("SIGTERM");
    await Promise.race([this.closed, delay(400)]);
    signal("SIGKILL");
    const closed = await Promise.race([this.closed.then(() => true), delay(500, false)]);
    return closed && groupGone(proc.pid);
  }
}
