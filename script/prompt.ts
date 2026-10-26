/** Reading a secret from a person at a terminal without echoing it, so it never lands in shell history or a process listing. */
export function promptSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new Error("No terminal to ask on. Run this from an interactive shell (or, for an automated run, supply the value in the environment as documented)."));
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let typed = "";
    const finish = (done: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      done();
    };
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\r" || c === "\n" || c === "\u0004") return finish(() => resolve(typed));
        if (c === "\u0003") return finish(() => reject(new Error("Cancelled.")));
        if (c === "\u007f" || c === "\b") typed = typed.slice(0, -1);
        else typed += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Asks twice and insists on a match. */
export async function promptNewSecret(label: string): Promise<string> {
  const first = await promptSecret(`${label}: `);
  const again = await promptSecret(`${label} (again): `);
  if (first !== again) throw new Error("The two entries did not match. Nothing was changed.");
  return first;
}
