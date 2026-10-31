import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function platformFiles(root) {
  const entries = await readdir(join(root, 'platforms'), { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name).sort();
  if (files.length === 0) throw new Error('No platform JSON files found in platforms/');
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file)) {
      throw new Error(`Invalid platform filename: ${file}`);
    }
  }
  return files;
}
