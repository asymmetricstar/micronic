#!/usr/bin/env node
/**
 * MicroNic entry point.
 *
 *   micronic                 interactive shell (bare `npm start`)
 *   micronic <command>       one-shot command; `micronic serve` runs the server
 *   micronic --daemon        headless DNS + API, one `Server Running ...` line, no shell
 *   micronic --help          the command list
 *   micronic --version       version line
 *
 * Configuration (environment variables):
 *   MICRONIC_HOST            listen address      (default 127.0.0.1)
 *   MICRONIC_PORT            UDP+TCP port        (default 5354; Windows reserves 5353 for mDNS)
 *   MICRONIC_DB              SQLite file         (default data/dns.db)
 *   MICRONIC_TTL             synthesised A TTL   (default 300)
 *   MICRONIC_API             HTTP API on/off     (default on)
 *   MICRONIC_API_PORT        HTTP API port       (default 8080)
 *   MICRONIC_ADMIN_PASSWORD  create "admin" when no users exist
 *   MICRONIC_SEED_ZONE       create this zone on first start (e.g. example.test)
 *   MICRONIC_SEED_IP         master IP for the seed zone (default 127.0.0.1)
 *   MICRONIC_USERNAME        sign in this account for one-shot commands
 *   MICRONIC_PASSWORD        ... with this password
 */
import { main } from './cli/index.js';
import { CliError, closeCli, closePrompts, errorMessage } from './cli/context.js';
import { errorMark } from './cli/theme.js';
main(process.argv.slice(2))
    .then(() => {
    closePrompts();
    closeCli();
})
    .catch((error) => {
    console.error(errorMark(errorMessage(error)));
    closePrompts();
    closeCli();
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
// Async work that rejects without being awaited must never kill the CLI with a
// raw Node stack. Turn it into a clean message and mark a failure exit code.
process.on('unhandledRejection', (reason) => {
    console.error(errorMark(`Unhandled promise rejection: ${errorMessage(reason)}`));
    process.exitCode = 1;
});
// Last-resort guard: a synchronous throw outside main() is reported cleanly.
process.on('uncaughtException', (error) => {
    console.error(errorMark(`Uncaught exception: ${errorMessage(error)}`));
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map