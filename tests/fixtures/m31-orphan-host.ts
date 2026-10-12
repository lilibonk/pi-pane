/**
 * The smallest host for the lost-host check: the product's RpcChild around the real pi RPC entry,
 * with one long shell command running. The harness kills this process with SIGKILL.
 * Loads the same build as the fixtures: the module beside PI_M0_EXTENSION, or the source.
 */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , cli, cwd, marker, extension] = process.argv;
const module = process.env.PI_M0_EXTENSION
  ? pathToFileURL(join(dirname(process.env.PI_M0_EXTENSION), "rpc-child.js")).href
  : new URL("../../src/extension/rpc-child.ts", import.meta.url).href;
const { RpcChild, runningPiRpcEntry } = await import(module) as typeof import("../../src/extension/rpc-child.ts");
const child = new RpcChild(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", ...(extension ? ["-e", extension] : [])], cwd!, runningPiRpcEntry(cli));
child.start(); child.activate();
await child.request("get_state", {}, 30_000);
console.log(JSON.stringify({ child: child.pid }));
void child.request("bash", { command: `sleep 240; echo ${marker}` }).catch(() => {});
setInterval(() => {}, 1000);
