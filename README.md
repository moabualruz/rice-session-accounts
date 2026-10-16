# rice-session-accounts

Manage saved Anthropic OAuth accounts in Claude Code.
`/rice-account` opens an account picker showing each saved name, email and plan.

**0.4.0:** this version switches accounts through the public
plugin API inside ordinary, unmodified `claude`. It sets authentication only in
the invoking process, replaces `/usage` and interactive `/status` with selected-account reports, and
shows the selected name, email, plan and usage in the plugin's status entry.
The earlier **0.3.0** release contains the withdrawn native-bridge guard.
No replacement launcher, preload, gateway
or proxy is part of this flow.

The ordinary-Claude native SDK proof is qualified against Claude Code
**2.1.301**. Older 2.1.296 and 2.1.299 cohorts check plugin and storage
compatibility, rather than the complete current account-switching proof.
Native panels outside the replaced `/usage` and `/status` commands can still display cached
machine-account metadata. The plugin does not claim to rewrite those internal
panels or the native credential cache.

The supported account kinds are the built-in `login`, separate `claudeai`
browser sign-ins, and `claudeai-token` setup tokens. Model and provider
configuration belongs to [rice-multi-models](https://github.com/moabualruz/rice-multi-models).

The plugin is named **rice-session-accounts**. Its command is **`/rice-account`**.
Account setup and credential storage support macOS, Linux (including WSL), and
native Windows. Install Node.js 22 or newer and make
`node` available in the environment where Claude runs. The setup helper and
credential-file backend use it.

See the [0.4.0 verification details](docs/verification/0.4.0.md).
The [0.3.0 verification details](docs/verification/0.3.0.md) are historical.
Current acceptance uses the public-API production proof described under
[Development checks](#development-checks).

## Install

Run this command in your terminal:

```sh
claude plugin install rice-session-accounts --marketplace moabualruz/rice-mods
```

This adds the Rice marketplace if necessary and installs the plugin. Start a new
Claude Code session and approve its requested capabilities when prompted.

Use the machine's ordinary `claude` command. To inspect saved accounts, enter:

```text
/rice-account
```

You should see the built-in `login` account and any saved accounts. Select a row
to use that account for this session, or press Escape to close the picker.
Installing the plugin does not sign you into another account.

The picker shows the selected account, its cached email and its subscription
tier, such as Pro, Max (5x), Team or Enterprise. Opening the picker reads local
metadata without making an Anthropic request. `Unknown` means the metadata is
unavailable. `Not signed in` means no saved native login was found. Run
`/rice-account check <name>` to verify a credential with Anthropic. Accounts
added with a setup token may not have local email or plan metadata.

In a headless session, `/rice-account` returns a text list. Use
`/rice-account list` whenever you want the text version explicitly.

If you already have the plugin, update it instead:

```sh
claude plugin marketplace update rice-mods
claude plugin update rice-session-accounts@rice-mods
```

Restart ordinary Claude Code after an update. No alternate command or startup
integration is needed.

## Add your personal Claude account

1. In Claude Code, save the account name:

   ```text
   /rice-account add personal-live
   ```

   The omitted kind defaults to `claudeai`, a separate claude.ai sign-in. The
   command prints one terminal command with this installation's exact paths.

2. Copy that generated command into a terminal on the same machine. For WSL,
   use a terminal inside the same WSL distribution. When different browsers
   hold different accounts, append `--manual --email you@example.com`, replacing
   the email with the account you want. The helper prints a sign-in URL without
   opening the default browser. Open it in the browser already signed into the
   intended account, authorize, then paste the returned code into the terminal.
   The helper verifies the resulting native account email before declaring it
   ready. `--email` alone is a login hint; it cannot select an account already
   signed into another browser.
   If the saved account is already signed in, the helper checks its local login
   status and skips the browser login. The check in the next step contacts
   Anthropic.

3. When setup succeeds, return to Claude Code:

   ```text
   /rice-account check personal-live
   ```

   The check reports the signed-in account. Then select it in `/rice-account`
   or enter `/rice-account personal-live`. Its next request uses that account.
   `/usage` reports the selected account's current usage when its grant permits
   the usage endpoint. In an interactive terminal, `/status` shows the selected
   email and plan, plus Claude's version, current model and working directory.

Browser sign-in is the only interactive part of a normal `claudeai` setup. The
helper chooses the credential backend for your operating system. You do not need
to construct `CLAUDE_CONFIG_DIR` paths or run macOS keychain commands yourself.

If you stopped partway through, resume without removing the saved account:

```text
/rice-account setup personal-live
```

This prints the terminal setup command again. Repeating
`/rice-account add personal-live` also resumes setup for the saved account. To
sign in again even when the helper finds a valid login, append `--login` to the
generated terminal command.

To have native Claude open a specific browser instead, append
`--browser <browser-executable>` to the generated command. Quote paths with
spaces. Use the browser's executable, not a shell command with arguments.
`--manual` and `--browser` are mutually exclusive and affect this helper's child
process only; neither changes the machine's default browser.

## Account kinds

For another browser sign-in, use the `claudeai` flow above. To use a setup token,
add a `claudeai-token` account and run the terminal command it prints:

```text
/rice-account add personal-token claudeai-token
```

The helper runs `claude setup-token`, then asks you to copy the generated token
into a hidden prompt. Enter the token in that terminal prompt.

| Kind | Example in Claude Code | Terminal setup |
| --- | --- | --- |
| `login` | `/rice-account login` | Built in. Restore the credentials this session started with. |
| `claudeai` | `/rice-account add personal-live` | A separate claude.ai browser sign-in. The mod renews its expiring login. |
| `claudeai-token` | `/rice-account add personal-token claudeai-token` | Generate a setup token and store it through the helper's hidden prompt. |

Account names may contain letters, digits, dots, underscores and hyphens, up to
40 characters. Start the name with a letter or digit. `login` is reserved for
the built-in account that restores this process's starting credentials.

The full add syntax is:

```text
/rice-account add <name> [kind] [key=value ...]
```

Use `label=` for an account label. A `claudeai-token` account also accepts
`service=` to choose its OS keyring service name. Enter actual setup tokens only
at the terminal helper's hidden prompt.
For an existing account, use `/rice-account setup <name>` to repeat its setup.
Use another name when adding an account with a different kind or configuration.

## Daily commands

| Command | Result |
| --- | --- |
| `/rice-account` | Open the account picker with saved names, emails, plans and this session's selection. Return a text list when a picker cannot be displayed. |
| `/rice-account list` | Show the text list of saved accounts and their cached identity metadata. |
| `/rice-account <name>` | Use a saved OAuth account for this session's next request and future descendants. |
| `/rice-account login` | Restore the credential environment this session started with. |
| `/rice-account check [name]` | Check the named sign-in or setup token, or the current account when omitted. Saved OAuth tokens use Anthropic's profile endpoint when their permissions allow it. |
| `/rice-account usage` | Query the selected account's five-hour and weekly usage windows when permitted. |
| `/usage` | After an account selection, show the selected account's fresh usage through the normal command. |
| `/rice-account setup <name>` | Print the terminal command to complete or repeat an account's setup. |
| `/rice-account remove <name>` | Remove a saved account's configuration. The command explains any remaining credential cleanup. |

Independent sessions started with ordinary `claude` keep their normal machine
login. `/rice-account login` restores this process's starting credential
environment; it remains available for recovery in an existing session.

The selected account applies to an existing subagent's next request, new
subagents, and `claude -p` children started through the supported process APIs.
Other running sessions and fresh independent sessions keep their normal login.
Returning to `login` restores this process's original credential environment.
Normal tool permissions still apply to child commands.

The original machine credential source remains available to Claude's own
renewal flow. Returning to `login` uses that source's current grant, including a
normal renewal made while another account was selected. The plugin renews the
additional browser accounts in their separate native stores.

Selected-account reporting comes from that account's OAuth usage endpoint.
When the lookup is unavailable, the plugin says so and exposes no stale account
windows. Delayed responses for the old account cannot overwrite the plugin's
selected-account report. Cooperating plugins' public authorization handles
follow this session's current account when their next request starts. Handles
observed before selection are updated too; unknown native handles remain with
Claude. A request already dispatched for A keeps A. Native panels that read internal cached metadata
directly remain a separate limitation, as described above.

## Credentials on each operating system

- A `claudeai` account uses Claude Code's own isolated login folder. On Linux,
  WSL and native Windows, Claude stores that login in the folder's native
  `.credentials.json` file. On macOS, Claude uses the keychain item associated
  with that folder. Rice preserves the native file's permissions on refresh;
  Windows files use a private owner-only ACL and reject reparse points.
- Setup tokens entered into this plugin's helper use the macOS Keychain
  or Linux Secret Service through `secret-tool`. On native Windows, they use
  Windows Credential Manager. The plugin does not create a separate plaintext
  token store.
- Linux `claudeai` browser login does not require `secret-tool`. Setup-token
  accounts do require `secret-tool`, a running Secret Service implementation and
  access to an unlocked collection in the same user session. Installing the
  executable alone does not provide a working keyring.
- Native Windows setup prints a command quoted for PowerShell. Browser login
  uses the ordinary native credential file. An explicitly requested optional
  `FORCE_WINDOWS_CREDMAN` browser store is refused with instructions rather than
  silently reading another store; this restriction does not affect setup-token
  accounts, which use the plugin's own Credential Manager entries.

If a Linux setup-token account reports that `secret-tool` is missing, install the
package that provides it for your distribution. Debian and Ubuntu use
`libsecret-tools`:

```sh
sudo apt-get install libsecret-tools
```

In a headless WSL environment, use the `claudeai` browser login, or configure a
working user D-Bus and Secret Service before adding setup-token accounts. The
helper reports missing prerequisites before prompting for a token.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `/rice-account` is unknown | Confirm `rice-session-accounts@rice-mods` is installed and enabled, then restart Claude Code. |
| `/rice-account add personal-live` asks for a kind, or repeating it says to remove the account first | The session has an older plugin version. Update the plugin and restart Claude Code, then run `/rice-account setup personal-live`. Keep the saved account. |
| `/usr/bin/security` fails with `ENOENT` on WSL or Linux | The session has the macOS-only credential code from an older version. Update and restart, then repeat setup or check. Linux uses its native credential file or Secret Service. |
| The account is saved but not signed in | Run `/rice-account setup <name>`, execute its generated command in a terminal on that machine, then check the account. |
| Browser login used the wrong account, or a login can no longer renew | Run `/rice-account setup <name>` again. Append `--login --manual --email intended@example.com` to its command. This prevents a different default browser from completing login before your intended browser. |
| A copied setup command no longer exists after a plugin update | Run `/rice-account setup <name>` again to get the current installed path. |
| `node` is missing or too old | Install Node.js 22 or newer on the machine running the helper, then rerun its command. WSL needs its own Linux Node installation. |
| A switch says the native account cache bridge is required | You still have 0.3.0 or its loaded hooks. Update to 0.4.0 and restart ordinary Claude. Do not follow historical launcher instructions. |
| A native account panel shows the machine account after switching | Use the selected-account status entry, `/usage` or interactive `/status`. The plugin does not rewrite every native panel's internal cached identity. |
| `/status` says it is unavailable in a print session | Claude rejects that command before plugin dispatch in print mode. Use `/usage` there; `/status` is supported in an interactive terminal. |
| A failed switch says its rollback could not restore the session | Requests are blocked while the account is unconfirmed. Run `/rice-account login` or select an account again; only a verified complete switch restores dispatch. |
| An older provider account is missing from the picker | This mod's account scope is Anthropic OAuth only. Legacy provider entries are retained in configuration but cannot be selected here. Configure providers in rice-multi-models. |

## Files and session behavior

The default config directory is `~/.claude`. When Claude Code starts with
`CLAUDE_CONFIG_DIR`, paths below are relative to that directory instead.

- `rice-session-accounts/accounts.json` contains account names, kinds and
  credential references.
- `rice-session-accounts/logins/<name>/` is each `claudeai` account's isolated
  native Claude config directory.
- The `rice-session-accounts` Keychain or Secret Service service stores named
  setup tokens by account name, unless the account specifies `service=`.
  Windows Credential Manager uses plugin-owned entries derived from that
  service and account reference.

The isolated folders hold only the additional account logins. Setup and account
management preserve the machine's shared Claude login and its settings, plugins,
skills, hooks, MCP servers and project files. Legacy provider entries in
`accounts.json` are preserved when saving supported accounts. The isolated
folders select credentials only. They do not replace the machine's settings,
plugins, skills, hooks, MCP servers or project files.

## Development checks

Run these from the repository root. The terminal helper tests use Node's built-in
test runner; plugin tests use Claude Code's native mod test runner.

```sh
npm run check
```

The full check requires ordinary Claude Code 2.1.301 on PATH. It runs Node tests,
native plugin tests, strict validation and `scripts/proof-public-auth.mjs`.
The latter copies the production hooks into an isolated HOME and drives the
real native SDK against local synthetic HTTP. It checks exhausted A to B,
an already-running agent's next request, both process APIs starting `claude -p`,
delayed A responses, the actual user-entered `/usage` command, cached public
authorization handles across selection and login restoration,
and a fresh independent session's original account. Machine settings and account
configuration must remain unchanged. Both an original environment token and a
native browser-login store are exercised. The storage case simulates an
external vendor renewal and requires restoration to use the renewed grant.
No real grant, provider inference,
installation, permission override, preload or launcher is used.

`npm run check:compat` runs the Node, plugin and validation checks without
claiming the current301 native SDK proof on an older engine. CI runs that
compatibility cohort on 2.1.296 and 2.1.299, and the full public proof on
2.1.301, with Linux and native Windows jobs. Historical native adapter unit
tests remain separately available in a Git checkout as `npm run test:legacy`; they are excluded
from ordinary-Claude activation acceptance.

Adapted from [simplecore-inc/claude-mods](https://github.com/simplecore-inc/claude-mods)
(MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). The adapted simplecore-inc/claude-mods code keeps its
own MIT notice in [LICENSES/](LICENSES/).
