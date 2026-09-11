/** Deterministic browser preview of every real panel route; no extension or game required. */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const build = await Bun.build({
	entrypoints: [path.join(root, "test/fixtures/panel-preview.ts")],
	target: "browser",
	define: {
		__SL_VERSION__: '"2.0.0"',
		__SL_BUILD__: '"ui-preview"',
		__SL_SPOOF_SEED__: '"preview"',
		__SL_LICENSE_URL__: '"https://sliced.gg"',
		__SL_LICENSE_ENFORCE__: "false",
		__SL_DEBUG__: "true",
	},
	plugins: [
		{
			name: "panel-html",
			setup(builder) {
				builder.onResolve({ filter: /\.html\?raw$/ }, (args) => ({
					path: path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, "")),
					namespace: "panel-html",
				}));
				builder.onLoad({ filter: /.*/, namespace: "panel-html" }, async (args) => ({
					contents: await Bun.file(args.path).text(),
					loader: "text",
				}));
			},
		},
	],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const script = await build.outputs[0]?.text();
const page = (await Bun.file(path.join(root, "pages/panel.html")).text()).replace(
	"../js/panel.js",
	"/preview.js"
);
const server = Bun.serve({
	port: 4179,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/preview.js")
			return new Response(script, { headers: { "Content-Type": "text/javascript" } });
		if (url.pathname === "/" || url.pathname === "/pages/panel.html")
			return new Response(page, { headers: { "Content-Type": "text/html" } });
		const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
		if (!file.startsWith(`${root}${path.sep}`) || !/^\/(css|assets)\//.test(url.pathname))
			return new Response("Not found", { status: 404 });
		return new Response(Bun.file(file));
	},
});
process.stdout.write(
	`Panel preview: ${server.url}?state=live\nStates: live, thinking, opponent, cached-opponent, cached-thinking, no-rec, unarmed, disabled, crashed, settings, engine, waiting, unsupported, login, expired, update, loading. Add &theme=light, &search=premove or &elo=3650.\n`
);
