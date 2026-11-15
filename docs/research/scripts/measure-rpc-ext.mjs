// Measure time from spawn to first get_state response in pi RPC mode (offline, isolated config).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const scratch = process.argv[2];
const bin = process.argv[3];
const agentDir = join(scratch, "pi-agent-empty");
const workDir = join(scratch, "pi-work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const start = performance.now();
const child = spawn(bin, ["--offline", "--mode", "rpc", "--no-session", "--no-skills"], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
	stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
	buf += d;
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		try {
			const msg = JSON.parse(line);
			if (msg.type === "response" && msg.command === "get_state") {
				const ms = performance.now() - start;
				const st = msg.data ?? {};
				console.log(JSON.stringify({ ms: Math.round(ms), success: msg.success, model: st.model?.id ?? null, keys: Object.keys(st) }));
				// RSS of child via ps
				const ps = spawn("ps", ["-o", "rss=", "-p", String(child.pid)]);
				let out = "";
				ps.stdout.on("data", (x) => (out += x));
				ps.on("close", () => {
					console.log(JSON.stringify({ rssMB: Math.round(Number(out.trim()) / 1024) }));
					child.stdin.end();
					setTimeout(() => child.kill(), 500);
				});
			} else {
				console.log("other:", line.slice(0, 200));
			}
		} catch {
			console.log("non-json:", line.slice(0, 200));
		}
	}
});
child.on("exit", (code) => {
	if (stderr) console.log("stderr:", stderr.slice(0, 500));
	console.log("exit", code);
});
child.stdin.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);
setTimeout(() => {
	console.log("timeout");
	child.kill();
}, 15000);
