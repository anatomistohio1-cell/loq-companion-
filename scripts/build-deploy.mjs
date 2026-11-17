import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = process.argv[2];
const targets = {
  nerv: {
    output: 'dist/nerv-deck',
    files: [
      'index.html',
      'clock.html',
      'race.html',
      'audio.html',
      'connect.html',
      'visualiser.html',
      'loq.html',
      'app.js',
      'styles.css',
      'race-calendars.json',
      'assets/race/hypercar-ferrari-499p.jpg',
      'assets/race/gt3-lamborghini-huracan-evo2.jpg',
      'assets/race/gtp-cadillac-porsche.jpg',
      'assets/race/lmp2-oreca-07.jpg',
      'assets/race/rally1-toyota-yaris.jpg',
    ],
  },
  loq: {
    output: 'dist/loq-link',
    files: ['loq-link/index.html', 'loq-link/loq-link.js', 'styles.css'],
  },
};

if (!targets[site]) {
  throw new Error('Choose a deploy target: "nerv" or "loq".');
}

const target = targets[site];
const outputDirectory = path.join(root, target.output);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of target.files) {
  const relativeDestination = site === 'nerv' ? file : path.basename(file);
  const destination = path.join(outputDirectory, relativeDestination);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, file), destination);
}

if (site === 'loq') {
  const deckUrl = process.env.NERV_DECK_URL || '';
  await writeFile(
    path.join(outputDirectory, 'deployment-config.js'),
    `window.NERV_DEPLOYMENT_CONFIG = Object.freeze({ deckUrl: ${JSON.stringify(deckUrl)} });\n`,
    'utf8',
  );
  const htmlPath = path.join(outputDirectory, 'index.html');
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(
    htmlPath,
    html.replace('</head>', '    <script src="deployment-config.js"></script>\n  </head>'),
    'utf8',
  );
}

console.log(`Built ${site} site into ${path.relative(root, outputDirectory)}.`);
