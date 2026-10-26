// Opt-in diagnostics for the intermittent multi-second stalls seen on a loaded
// development machine. Enabled with STALL_PROBE=<log file>. It changes nothing
// about behaviour; it records, with timestamps, when the event loop was blocked,
// when a DNS lookup, a pool connect or a query was slow, and how much CPU the
// process used meanwhile, so a stall can be told apart: CPU-bound code, an
// operating-system pause, a network/DNS hang, or a slow database.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import { monitorEventLoopDelay } from "node:perf_hooks";
import pg from "pg";

const file = process.env.STALL_PROBE;
if (file) {
  const log = (kind: string, ms: number, extra = "") =>
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${kind} ${Math.round(ms)}ms ${extra}\n`);

  // 1. Event-loop lag: a timer that should fire every 100 ms.
  let last = performance.now();
  let cpu = process.cpuUsage();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - 100;
    const used = process.cpuUsage(cpu);
    if (lag > 750) log("LOOP_LAG", lag, `cpu_user=${Math.round(used.user / 1000)}ms cpu_sys=${Math.round(used.system / 1000)}ms wall=${Math.round(now - last)}ms`);
    last = now;
    cpu = process.cpuUsage();
  }, 100).unref();
  monitorEventLoopDelay().enable();

  // 2. DNS lookups.
  const lookup = dns.lookup;
  (dns as any).lookup = function (host: string, ...args: any[]) {
    const t = performance.now();
    const cb = args[args.length - 1];
    args[args.length - 1] = (...r: any[]) => {
      const d = performance.now() - t;
      if (d > 500) log("DNS_SLOW", d, host);
      return cb(...r);
    };
    return (lookup as any).call(dns, host, ...args);
  };

  // 3. Pool connects and queries.
  const connect = pg.Pool.prototype.connect as any;
  (pg.Pool.prototype as any).connect = function (...args: any[]) {
    if (typeof args[0] === "function") return connect.apply(this, args);
    const t = performance.now();
    const waiting = (this as any).waitingCount, total = (this as any).totalCount, idle = (this as any).idleCount;
    return connect.apply(this, args).then((c: any) => {
      const d = performance.now() - t;
      if (d > 500) log("POOL_CONNECT_SLOW", d, `total=${total} idle=${idle} waiting=${waiting}`);
      return c;
    });
  };
  const query = pg.Client.prototype.query as any;
  (pg.Client.prototype as any).query = function (...args: any[]) {
    const t = performance.now();
    const text = String(typeof args[0] === "string" ? args[0] : args[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 90);
    const res = query.apply(this, args);
    if (res && typeof res.then === "function") {
      return res.then((r: any) => { const d = performance.now() - t; if (d > 1000) log("QUERY_SLOW", d, text); return r; });
    }
    return res;
  };
}
