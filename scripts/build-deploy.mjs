// Assembles a static publish directory for one of the two frontends.
// Usage: node scripts/build-deploy.mjs <nerv|loq>
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = {
  nerv: { out: "dist/nerv-deck", title: "NERV Deck", entries: ["index.html"] },
  loq: { out: "dist/loq-link", title: "LOQ Link", entries: ["loq-link.html", "loq-link/index.html", "index.html"] },
};

const name = process.argv[2];
const target = targets[name];
if (!target) {
  console.error(`Unknown target "${name}". Expected one of: ${Object.keys(targets).join(", ")}`);
  process.exit(1);
}

// Static assets shared by both frontends; copied only when present.
const sharedAssets = ["styles.css", "race-calendars.json", "assets", "images", "js", "src"];

const outDir = join(root, target.out);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const asset of sharedAssets) {
  const from = join(root, asset);
  if (existsSync(from)) cpSync(from, join(outDir, asset), { recursive: true });
}

const entry = target.entries.find((file) => existsSync(join(root, file)));
if (entry) {
  cpSync(join(root, entry), join(outDir, "index.html"));
  console.log(`Built ${target.title} from ${entry} into ${target.out}`);
} else {
  console.warn(`No ${target.title} page found (looked for ${target.entries.join(", ")}); writing a placeholder.`);
  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${target.title}</title>
  ${existsSync(join(root, "styles.css")) ? '<link rel="stylesheet" href="styles.css">' : ""}
</head>
<body>
  <main style="max-width:40rem;margin:4rem auto;padding:0 1.5rem;font-family:system-ui,sans-serif">
    <h1>${target.title}</h1>
    <p>The ${target.title} frontend files have not been added to this repository yet.</p>
  </main>
</body>
</html>
`,
  );
}
