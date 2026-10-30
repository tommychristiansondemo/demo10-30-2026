// Copies the OpenAPI spec into the static site so the Developers page can render it.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
copyFileSync(`${root}api/openapi.yaml`, `${root}web/public/openapi.yaml`);
console.log('copied api/openapi.yaml → web/public/openapi.yaml');
