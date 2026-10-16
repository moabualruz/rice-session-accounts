# rice-session-accounts

Save several Anthropic OAuth accounts and choose which one a Claude Code session uses.
`/rice-account` opens an account picker showing each saved name, email and plan.
Choose a row, or use `/rice-account personal-live`, to switch the current session
from its next request, including subagents and `claude -p` processes it starts
afterward. Other running sessions keep their accounts.

The supported account kinds are the built-in `login`, separate `claudeai`
browser sign-ins, and `claudeai-token` setup tokens. Model and provider
configuration belongs to [rice-multi-models](https://github.com/moabualruz/rice-multi-models).

The plugin is named **rice-session-accounts**. Its command is **`/rice-account`**.
It supports macOS and Linux, including WSL. Install Node.js 22 or newer and make
`node` available in the environment where Claude runs. The setup helper and the
Linux credential backend use it.

Version 0.2.0 was verified with native Claude Code 2.1.296 on WSL and 2.1.300 on
macOS. See [verification details](docs/verification/0.2.0.md) for the checks and
their scope.

## Install

Run this command in your terminal:

```sh
claude plugin install rice-session-accounts --marketplace moabualruz/rice-mods
```

This adds the Rice marketplace if necessary and installs the plugin. Start a new
Claude Code session, approve the plugin's requested capabilities when prompted,
and enter:

```text
/rice-account
```

You should see the built-in `login` account, which restores the credentials this
session started with. Choose an account row to switch, or press Escape to close
the picker. Installing the plugin does not sign you into another account.

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

Restart Claude Code after updating so the session loads the new plugin code.

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
   status and skips the browser login. The check in the next step contacts the
   Anthropic.

3. When setup succeeds, return to Claude Code:

   ```text
   /rice-account check personal-live
   /rice-account personal-live
   ```

   The check reports the signed-in account. The switch takes effect on this
   session's next request. `/rice-account` marks the selected account with
   `this session`.

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
| `/rice-account <name>` | Switch the current session to a saved account. |
| `/rice-account login` | Restore the credential environment this session started with. |
| `/rice-account check [name]` | Check the named sign-in or setup token, or the current account when omitted. Saved OAuth tokens use Anthropic's profile endpoint when their permissions allow it. |
| `/rice-account usage` | Show the current account's reported five-hour and weekly usage windows. Some setup tokens cannot access this information. |
| `/rice-account setup <name>` | Print the terminal command to complete or repeat an account's setup. |
| `/rice-account remove <name>` | Remove a saved account's configuration. The command explains any remaining credential cleanup. |

Independent sessions launched from your usual terminal keep their normal login.
Subagents and child Claude processes started by a switched session inherit its
selected account. `/rice-account login` restores the credential environment the
current process started with, including an inherited account for a child process.
A selection survives plugin reload and `/clear` in the current process. Changing
an account does not alter already-running independent sessions or children.

## Linux and WSL credentials

- A `claudeai` account uses Claude Code's own isolated login folder. On Linux and
  WSL, Claude stores that login in the folder's native `.credentials.json` file.
  On macOS, Claude uses the keychain item associated with that folder.
- Setup tokens entered into this plugin's helper use the macOS Keychain
  or Linux Secret Service through `secret-tool`. The plugin does not create a
  separate plaintext token store.
- Linux `claudeai` browser login does not require `secret-tool`. Setup-token
  accounts do require `secret-tool`, a running Secret Service implementation and
  access to an unlocked collection in the same user session. Installing the
  executable alone does not provide a working keyring.

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
| An older provider account is missing from the picker | This mod now switches Anthropic OAuth accounts only. Legacy provider entries are retained in configuration but cannot be selected here. Configure providers in rice-multi-models. |

## Files and session behavior

The default config directory is `~/.claude`. When Claude Code starts with
`CLAUDE_CONFIG_DIR`, paths below are relative to that directory instead.

- `rice-session-accounts/accounts.json` contains account names, kinds and
  credential references.
- `rice-session-accounts/logins/<name>/` is each `claudeai` account's isolated
  native Claude config directory.
- The `rice-session-accounts` Keychain or Secret Service service stores named
  setup tokens by account name, unless the account specifies `service=`.

The isolated folders hold only the additional account logins. Switching accounts
does not change the current session's config directory, settings, installed
plugins, skills, hooks, MCP servers or project files. The plugin changes Claude's
OAuth credential environment inside the current process and leaves the machine's
shared Claude login in place. Legacy provider entries in `accounts.json` are
preserved when saving supported accounts.

## Development checks

Run these from the repository root. The terminal helper tests use Node's built-in
test runner; plugin tests use Claude Code's native mod test runner.

```sh
npm run check
```

No dependency installation is needed. This also runs an isolated native process
proof for subagents, both process APIs, Bash, `claude -p`, sibling sessions and a
fresh session. Credentials and model replies in that proof are synthetic; the
processes and configuration inheritance are real. It does not use your accounts
or install the plugin.

Adapted from [simplecore-inc/claude-mods](https://github.com/simplecore-inc/claude-mods)
(MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). The adapted simplecore-inc/claude-mods code keeps its
own MIT notice in [LICENSES/](LICENSES/).
