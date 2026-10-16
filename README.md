# rice-session-accounts

Manage saved Anthropic OAuth accounts in Claude Code.
`/rice-account` opens an account picker showing each saved name, email and plan.

**Current status:** published **0.3.0** does not meet the requirement for full
account switching inside ordinary, unmodified `claude`. Its native account and
usage behavior relied on a startup preload integration that is no longer an
accepted installation mechanism. The previous launcher-based installation path
is withdrawn. It must not be recreated as part of setup.

Account setup, the email/tier picker, saved-account checks and credential storage
remain available. Without the native bridge, the current guard refuses a switch
to a named account. Reloading the plugin does not add that bridge or fix native
usage reporting. There is currently no recommended activation command that
provides the full switching behavior through the exposed plugin API. See the
[plugin API findings](https://github.com/moabualruz/rice-multi-models/blob/main/docs/research/plugin-only-activation-20261016.md).

The supported account kinds are the built-in `login`, separate `claudeai`
browser sign-ins, and `claudeai-token` setup tokens. Model and provider
configuration belongs to [rice-multi-models](https://github.com/moabualruz/rice-multi-models).

The plugin is named **rice-session-accounts**. Its command is **`/rice-account`**.
Account setup and credential storage support macOS, Linux (including WSL), and
native Windows. Install Node.js 22 or newer and make
`node` available in the environment where Claude runs. The setup helper and
credential-file backend use it.

The [0.3.0 verification details](docs/verification/0.3.0.md) record historical
native SDK, usage and platform checks. Those results used the rejected startup
integration; they do not establish full switching support in ordinary `claude`.

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

You should see the built-in `login` account and any saved accounts. Press Escape
to close the picker. In ordinary Claude, selecting a named account currently
returns the native-bridge refusal described above. Installing the plugin does
not sign you into another account or make switching available.

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

Restart ordinary Claude Code to load the updated plugin. `/reload-plugins` can
reload function hooks in a running session; it cannot supply the missing native
account bridge.

## Add your personal Claude account

1. In Claude Code, save the account name:

   ```text
   /rice-account add personal-live
   ```

   The omitted kind defaults to `claudeai`, a separate claude.ai sign-in. The
   command prints one terminal command with this installation's exact paths.

2. Copy that generated command into a terminal on the same machine. For WSL,
   use a terminal inside the same WSL distribution. The helper starts Claude's
   browser sign-in using a separate account folder, waits for the login to
   finish, and checks the saved credential. Choose the intended account in the
   browser. Follow the printed browser instructions if WSL cannot open it.
   If the saved account is already signed in, the helper checks its local login
   status and skips the browser login. The check in the next step contacts
   Anthropic.

3. When setup succeeds, return to Claude Code:

   ```text
   /rice-account check personal-live
   ```

   The check reports the signed-in account. `/rice-account` shows its cached
   email and tier. Setup and a successful credential check do not switch the
   current session; named switching remains unavailable without the rejected
   native integration.

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
| `/rice-account <name>` | Currently refuses a named switch in ordinary Claude because the native bridge is absent. |
| `/rice-account login` | Restore the credential environment this session started with. |
| `/rice-account check [name]` | Check the named sign-in or setup token, or the current account when omitted. Saved OAuth tokens use Anthropic's profile endpoint when their permissions allow it. |
| `/rice-account usage` | Query the current account's reported five-hour and weekly usage windows when permitted. This does not repair native status-line reporting or select a saved account. |
| `/rice-account setup <name>` | Print the terminal command to complete or repeat an account's setup. |
| `/rice-account remove <name>` | Remove a saved account's configuration. The command explains any remaining credential cleanup. |

Independent sessions started with ordinary `claude` keep their normal machine
login. `/rice-account login` restores this process's starting credential
environment; it remains available for recovery in an existing session.

The required behavior is per-session switching, including an existing
subagent's next request, correct account identity and immediate usage reset
without changing other sessions or machine configuration. Published 0.3.0
demonstrated that behavior only with its startup integration. The exposed
plugin API does not currently provide the complete replacement. Do not treat
setup, a picker selection or plugin reload as proof that these requirements
are met in ordinary Claude.

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
| Browser login used the wrong account, or a login can no longer renew | Run `/rice-account setup <name>` again. Append `--login` to the generated terminal command to force a fresh sign-in. |
| A copied setup command no longer exists after a plugin update | Run `/rice-account setup <name>` again to get the current installed path. |
| `node` is missing or too old | Install Node.js 22 or newer on the machine running the helper, then rerun its command. WSL needs its own Linux Node installation. |
| A switch says the native account cache bridge is required | This is the current limitation in ordinary Claude. Do not follow the published version's historical launcher instructions. No compliant activation command is available; `login` remains available to restore launch credentials. |
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
`accounts.json` are preserved when saving supported accounts. Historical saved
runtime selections and private runtimes have been retained; they are not an
activation mechanism for ordinary Claude.

## Development checks

Run these from the repository root. The terminal helper tests use Node's built-in
test runner; plugin tests use Claude Code's native mod test runner.

```sh
npm run check
```

These are contributor checks for the published implementation, including its
historical startup integration, rather than ordinary-Claude acceptance proof.
No dependency installation is needed. This also runs an isolated native process
proof for subagents, both process APIs, Bash, `claude -p`, sibling sessions and a
fresh session. Credentials and model replies in that proof are synthetic; the
processes and configuration inheritance are real. It does not use your accounts
or install the plugin.
The actual native SDK proof also checks main and existing-agent Authorization
headers against synthetic A/B credentials, immediate usage reset, and a held
old-account response. The launcher proof installs only into its owned temporary
HOME and checks saved-runtime selection and failure recovery. Both are isolated
from real accounts and provider services.

Adapted from [simplecore-inc/claude-mods](https://github.com/simplecore-inc/claude-mods)
(MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). The adapted simplecore-inc/claude-mods code keeps its
own MIT notice in [LICENSES/](LICENSES/).
