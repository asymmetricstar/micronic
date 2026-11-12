/**
 * Account administration. Listing and changing accounts needs an admin; every
 * signed-in user may change their own password. The last admin cannot be
 * removed or demoted, so the database always keeps someone in control.
 */
import { CliError, answer, cli, prompts } from '../context.js';
import { hasFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, dim, formatDate, note, success, table } from '../theme.js';
const ROLES = ['admin', 'dns', 'none'];
function userName(input) {
    return input.startsWith('@') ? input.slice(1) : input;
}
function findUser(input) {
    const user = cli().app.users.getUserByName(userName(input));
    if (!user)
        throw new CliError(`no account named "@${userName(input)}"`);
    return user;
}
function parseRole(input) {
    const role = input.trim().toLowerCase();
    if (!ROLES.includes(role))
        throw new CliError(`unknown role "${input}"; use admin, dns or none`);
    return role;
}
function adminCount() {
    return cli().app.users.listUsers().filter((user) => user.role === 'admin').length;
}
function assertNotLastAdmin(user, why) {
    if (user.role === 'admin' && adminCount() === 1) {
        throw new CliError(`@${user.username} is the last admin; ${why} would lock the console`);
    }
}
function listUsers() {
    const { app } = cli();
    const users = app.users.listUsers();
    if (users.length === 0) {
        note('no accounts yet: `register` creates the first admin');
        return;
    }
    console.log(table(['ID', 'USERNAME', 'ROLE', 'CREATED'], users.map((user) => [String(user.id), `@${user.username}`, user.role, formatDate(user.createdAt)])));
    note(`${users.length} account(s)`);
}
async function addUser(argv) {
    const { app } = cli();
    const username = argv[0] ?? answer(await prompts().ask('Username: '), 'username');
    const roleInput = argv[1] ?? (await prompts().ask(`Role ${dim('[admin/dns/none]')} ${dim('(dns)')}: `)).trim();
    const role = parseRole(roleInput === '' ? 'dns' : roleInput);
    const password = await prompts().secret('Password: ');
    if (password === '')
        throw new CliError('password is required');
    const again = await prompts().secret('Password again: ');
    if (password !== again)
        throw new CliError('passwords do not match');
    const user = app.users.createUser({ username, password, role });
    success(`created ${bold(`@${user.username}`)} ${dim(`(${user.role})`)}`);
}
async function changeRole(argv) {
    const { app } = cli();
    const name = argv[0] ?? answer(await prompts().ask('Account: '), 'account');
    const roleInput = argv[1] ?? (await prompts().ask('Role (admin/dns/none): ')).trim();
    const user = findUser(name);
    const role = parseRole(roleInput);
    if (role !== 'admin')
        assertNotLastAdmin(user, 'demoting it');
    const updated = app.users.updateUser(user.id, { role });
    success(`${bold(`@${updated.username}`)} is now ${dim(updated.role)}`);
}
async function removeUser(argv, yes) {
    const { app, session } = cli();
    const name = argv[0] ?? answer(await prompts().ask('Account to remove: '), 'account');
    const user = findUser(name);
    assertNotLastAdmin(user, 'deleting it');
    const wasMe = session.user?.id === user.id;
    if (!yes) {
        const confirmed = await prompts().confirm(`delete account @${user.username}?`, false);
        if (!confirmed) {
            note('cancelled');
            return;
        }
    }
    app.tokens.revokeAllForUser(user.id);
    app.users.deleteUser(user.id);
    if (wasMe)
        session.signOut();
    success(`removed ${bold(`@${user.username}`)} ${dim('· API tokens revoked')}`);
}
async function changePassword(argv) {
    const { app, session } = cli();
    const me = session.requireUser();
    const name = argv[0] ?? me.username;
    const target = findUser(name);
    if (target.id !== me.id && me.role !== 'admin') {
        throw new CliError(`@${me.username} has role "${me.role}"; changing another password needs an admin`);
    }
    const password = await prompts().secret(`New password for @${target.username}: `);
    if (password === '')
        throw new CliError('password is required');
    const again = await prompts().secret('Password again: ');
    if (password !== again)
        throw new CliError('passwords do not match');
    app.users.updateUser(target.id, { password });
    app.tokens.revokeAllForUser(target.id);
    success(`password changed for ${bold(`@${target.username}`)} ${dim('· API tokens revoked')}`);
}
export const userSpec = {
    name: 'user',
    aliases: ['users'],
    group: 'Server',
    summary: 'Manage NIC accounts and roles',
    usage: 'user <list|add|role|rm|passwd> [username] [role] [options]',
    notes: 'Roles: admin (everything), dns (zones and records), none (read-only console).\n' +
        'Listing and changing accounts requires an admin; anyone may change their own password.',
    actions: [
        { name: 'list', summary: 'Every account with role and creation date' },
        { name: 'add', summary: 'Create an account (admin only)' },
        { name: 'role', summary: 'Change an account role (admin only)' },
        { name: 'rm', summary: 'Delete an account (admin only)' },
        { name: 'passwd', summary: 'Set a new password for yourself or, as admin, anyone' },
    ],
    flags: [{ name: 'yes', short: 'y', summary: 'Skip the confirmation on rm' }],
    examples: ['user list', 'user add leo dns', 'user role leo admin', 'user passwd', 'user rm leo --yes'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const action = args.positionals[0] ?? 'list';
        const rest = args.positionals.slice(1);
        const { session } = cli();
        switch (action) {
            case 'list':
            case 'ls':
                session.requireAdmin();
                return listUsers();
            case 'add':
            case 'create':
                session.requireAdmin();
                return addUser(rest);
            case 'role':
                session.requireAdmin();
                return changeRole(rest);
            case 'rm':
            case 'delete':
                session.requireAdmin();
                return removeUser(rest, hasFlag(args, 'yes'));
            case 'passwd':
            case 'password':
                return changePassword(rest);
            default:
                throw new CliError(`unknown user action "${action}"; try: list, add, role, rm, passwd`);
        }
    },
};
//# sourceMappingURL=user.js.map