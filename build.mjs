import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyOverlay, validateReferences } from './lib/config.mjs';
import { platformFiles } from './lib/platforms.mjs';

const root = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run build');
    return;
  }
  if (args.length) throw new Error('Use --help for usage');
  await buildConfigurations(root);
}

export async function buildConfigurations(root) {
  const files = await platformFiles(root);
  const readJSON = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
  const common = await readJSON('common.json');
  const generated = new Map();
  for (const file of files) {
    try {
      const config = applyOverlay(common, await readJSON(`platforms/${file}`));
      validateReferences(config);
      generated.set(file, JSON.stringify(config, null, 2) + '\n');
      console.log(`${file}: generated and references checked`);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  const output = join(root, 'dist');
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Generate and check every platform before replacing outputs.
  for (const [file, content] of generated) {
    const staged = join(output, `.${file}.tmp`);
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, join(output, file));
    console.log(`Generated dist/${file}`);
  }
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && !generated.has(entry.name)) {
      await rm(join(output, entry.name));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
