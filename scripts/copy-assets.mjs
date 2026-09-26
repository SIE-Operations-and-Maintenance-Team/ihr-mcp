import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
cpSync(join(here, '..', 'src', 'web', 'public'), join(here, '..', 'dist', 'web', 'public'), { recursive: true });
