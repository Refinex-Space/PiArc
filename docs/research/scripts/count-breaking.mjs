// Count "Breaking Changes" bullet entries per version in a Keep-a-Changelog style file.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const lines = readFileSync(file, "utf8").split("\n");
const versions = [];
let cur = null;
let inBreaking = false;
for (const line of lines) {
	const m = line.match(/^## \[([^\]]+)\](?: - (\S+))?/);
	if (m) {
		cur = { version: m[1], date: m[2] ?? "", breaking: 0 };
		versions.push(cur);
		inBreaking = false;
		continue;
	}
	if (/^### /.test(line)) {
		inBreaking = /breaking/i.test(line);
		continue;
	}
	if (cur && inBreaking && /^- /.test(line)) cur.breaking++;
}
const since = process.argv[3] ?? "0000-00-00";
const recent = versions.filter((v) => v.date >= since);
const withBreaking = recent.filter((v) => v.breaking > 0);
console.log(`file=${file}`);
console.log(`versions total=${versions.length}, since ${since}: ${recent.length} releases, ${withBreaking.length} with breaking, ${recent.reduce((a, v) => a + v.breaking, 0)} breaking bullets`);
console.log(withBreaking.map((v) => `${v.version}(${v.date}):${v.breaking}`).join(" "));
