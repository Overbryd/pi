import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const resolvedVersion of ["8.12.2", "8.12.1"]) {
	test(`installer validates exact dependency overrides against Undici ${resolvedVersion}`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-install-override-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
		copyFileSync(
			new URL("./generate-coding-agent-install-lock.mjs", import.meta.url),
			join(root, "scripts/generate-coding-agent-install-lock.mjs"),
		);
		const codingAgent = {
			name: "@earendil-works/pi-coding-agent",
			version: "1.3.0",
			dependencies: { openai: "7.19.0", "@google/genai": "2.21.0", protobufjs: "7.6.6" },
			overrides: { "undici@8.10.2": "8.12.2" },
		};
		writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify(codingAgent));
		const packages = {
			"": { name: "fixture", version: "1.0.0" },
			"packages/coding-agent": codingAgent,
			"node_modules/openai": { version: "7.19.0", dependencies: { undici: "8.10.2" } },
			"node_modules/undici": { version: resolvedVersion },
			"node_modules/@google/genai": { version: "2.21.0", hasInstallScript: true },
			"node_modules/protobufjs": { version: "7.6.6", hasInstallScript: true },
		};
		writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));

		const result = spawnSync(process.execPath, [join(root, "scripts/generate-coding-agent-install-lock.mjs")], {
			cwd: root,
			encoding: "utf8",
		});

		if (resolvedVersion !== "8.12.2") {
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /undici@8\.12\.2 resolves to 8\.12\.1/);
			return;
		}
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const manifest = JSON.parse(readFileSync(join(root, "packages/coding-agent/install-lock/package.json"), "utf8"));
		const lock = JSON.parse(readFileSync(join(root, "packages/coding-agent/install-lock/package-lock.json"), "utf8"));
		assert.deepEqual(manifest.overrides, codingAgent.overrides);
		assert.equal(lock.packages["node_modules/undici"].version, "8.12.2");
	});
}
