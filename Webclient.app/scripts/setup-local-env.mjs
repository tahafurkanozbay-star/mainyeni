import { access, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(scriptDirectory, '..');
const source = join(appDirectory, '.env.example');
const target = join(appDirectory, '.env');

try {
  await access(target, constants.F_OK);
  process.stdout.write('[local-env] Existing .env preserved.\n');
} catch {
  await copyFile(source, target);
  process.stdout.write('[local-env] Created .env from .env.example.\n');
}
