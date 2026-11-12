/**
 * Every static, user-facing name in one place. Change these and the banner,
 * prompt, help page, environment variables and history folder follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(here, '../../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
export const SETTINGS = {
    packageName: 'micro-nic',
    /** Command installed on PATH (`bin` in package.json). */
    bin: 'micronic',
    /** Product name shown next to the label. */
    name: 'micro-nic',
    /** Wordmark at the start of the ASCII logo: `µnic ━━━━ ●`. */
    mark: 'µnic',
    version: packageJson.version ?? '0.0.0',
    /** Short label printed next to the name: `micro-nic • DNS`. */
    label: 'DNS',
    tagline: 'authoritative DNS + NIC console',
    description: 'an authoritative DNS/NIC server in Node.js + TypeScript',
    footer: 'Private build',
    /** Prefix for environment variables (MICRONIC_HOST, MICRONIC_PORT, ...). */
    envPrefix: 'MICRONIC',
    /** Folder under the home directory holding the shell history. */
    configDir: '.micronic',
};
/** The command users type. */
export const BIN = SETTINGS.bin;
//# sourceMappingURL=settings.js.map