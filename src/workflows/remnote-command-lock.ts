import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Scans, immediate sends and promotion share one writer across processes. */
export function commandLock(configFile: string): () => void {
  const file = path.join(path.dirname(configFile), "command-run.lock");
  const owner = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, owner }));
      fs.closeSync(handle);
      return () => {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { owner?: string };
        if (current.owner === owner) fs.unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
      try {
        process.kill(prior.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        fs.unlinkSync(file);
        continue;
      }
      throw new Error("command-run-busy: 命令分发正在运行，请等待原回执");
    }
  }
  throw new Error("command-run-busy: 命令分发锁尚未释放");
}
