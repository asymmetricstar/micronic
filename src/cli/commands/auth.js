/**
 * Account commands. Accounts live in the local SQLite database; the session is
 * held in memory for this process only, so nothing is written to disk and
 * `logout` (or exiting the shell) ends it.
 */
import { CliError, answer, cli, prompts } from '../context.js';
import { parseCommandArgs, flagValue, hasFlag } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, gold, dim, field, formatDate, note, success } from '../theme.js';
export const loginSpec = {
    name: 'login',
    aliases: ['signin'],
    group: 'Account',
    summary: 'Sign in to the NIC console',
    usage: 'login [username] [--password <password>]',
    notes: 'The password is checked against the local account database and the session is kept\n' +
        'in memory for this shell only. Omit the username and password to be prompted.',
    flags: [{ name: 'password', short: 'p', value: '<password>', summary: 'Password (prompted when omitted)' }],
    examples: ['login', 'login admin'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const { app, session } = cli();
        if (session.signedIn) {
            const user = session.user;
            success(`already signed in as ${bold(`@${user?.username ?? ''}`)} ${dim(`(${user?.role ?? '-'})`)}`);
            note(`use ${gold('logout')} first to switch accounts`);
            return;
        }
        const username = args.positionals[0] ?? answer(await prompts().ask('Username: '), 'username');
        const password = flagValue(args, 'password') ?? (await prompts().secret('Password: '));
        if (password === '')
            throw new CliError('password is required');
        const user = app.users.authenticate(username, password);
        if (user === undefined)
            throw new CliError('invalid username or password');
        session.signIn(user);
        success(`signed in as ${bold(`@${user.username}`)} ${dim(`(${user.role})`)}`);
        note(`${app.zones.listZones().length} zone(s) · ${app.zones.listRecords().length} record(s) in this database`);
    },
};
export const registerSpec = {
    name: 'register',
    aliases: ['signup'],
    group: 'Account',
    summary: 'Create an account; the first one becomes the admin',
    usage: 'register',
    notes: 'The first account is always allowed and becomes the admin. Further self-service\n' +
        'signups require `config set register on`; they start read-only (role "none") and an\n' +
        'admin can promote them with `user role`. While registration is closed, admins add\n' +
        'people with `user add`.',
    examples: ['register'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const { app, session } = cli();
        const existing = app.users.listUsers().length;
        if (existing > 0 && !app.settings.bool('register', false)) {
            throw new CliError('registration is closed; enable it with `config set register on`, or ask an admin to run `user add`');
        }
        const username = args.positionals[0] ?? answer(await prompts().ask('Username: '), 'username');
        const password = await prompts().secret('Password: ');
        if (password === '')
            throw new CliError('password is required');
        const again = await prompts().secret('Password again: ');
        if (password !== again)
            throw new CliError('passwords do not match');
        const role = existing === 0 ? 'admin' : 'none';
        const user = app.users.createUser({ username, password, role });
        session.signIn(user);
        success(`created and signed in ${bold(`@${user.username}`)} ${dim(`(${user.role})`)}`);
        note(existing === 0
            ? 'next: create a zone with `domain new <name> <ip>`'
            : 'self-service accounts start read-only; an admin can promote you with `user role`');
    },
};
export const logoutSpec = {
    name: 'logout',
    group: 'Account',
    summary: 'End the current session',
    usage: 'logout',
    examples: ['logout'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const { session } = cli();
        if (!session.signedIn) {
            note('already signed out');
            return;
        }
        const username = session.user?.username;
        session.signOut();
        success(`signed out${username === undefined ? '' : ` ${bold(`@${username}`)}`}`);
    },
};
export const whoamiSpec = {
    name: 'whoami',
    aliases: ['me'],
    group: 'Account',
    summary: 'Show the signed-in account',
    usage: 'whoami',
    examples: ['whoami'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const { app, session } = cli();
        const user = session.requireUser();
        console.log(field('username', bold(`@${user.username}`)));
        console.log(field('role', dim(user.role)));
        console.log(field('created', formatDate(user.createdAt)));
        console.log(field('domain', session.domain ?? dim('not selected')));
        console.log(field('server', session.server ? `${session.server.host}:${session.server.port}` : dim('stopped')));
        console.log(field('database', dim(app.dbPath)));
    },
};
//# sourceMappingURL=auth.js.map