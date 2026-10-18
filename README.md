# Rice Accounts

Rice Accounts lets you switch between saved Anthropic (Claude.ai) OAuth accounts
**inside one Claude Code session**. Run `/rice-account`, pick an account by name,
email and plan, and that session (its subagents, compaction and any `claude -p`
it starts) uses it from the next request. Other sessions keep their own account,
and your machine login is never changed.

It is a plugin ("mod") for ordinary, unmodified `claude`. It installs no
launcher, alias, preload, proxy or gateway. "Rice" is just the name of the
marketplace it ships in ([rice-mods](https://github.com/moabualruz/rice-mods)).
Model and provider setup (Codex, OpenRouter, local models) belongs to
[rice-multi-models](https://github.com/moabualruz/rice-multi-models).

## Requirements

- Claude Code 2.1.296 or newer. Tested with 2.1.296, 2.1.299, 2.1.301 and
  2.1.302; the real-binary account-switching proofs run on 2.1.301 and 2.1.302.
- Node.js 22 or newer on the `PATH` of the environment where Claude runs, and in
  the terminal where you run the setup helper. WSL needs its own Linux Node.js.
- `claude` available in that terminal for setup (set `RICE_ACCOUNTS_CLAUDE` to an
  absolute path if it is not on `PATH`).
- A Claude plan for each account you add (Pro, Max, Team or Enterprise).
- macOS, Linux, WSL or native Windows.

## Install, update, remove

```sh
claude plugin install rice-session-accounts --marketplace moabualruz/rice-mods
```

Start a new Claude Code session and approve the capabilities it asks for.
Installing does not sign you into anything.

Update (then `/reload-plugins` or restart Claude Code):

```sh
claude plugin marketplace update rice-mods
claude plugin update rice-session-accounts@rice-mods
```

Remove: `claude plugin uninstall rice-session-accounts@rice-mods`. This leaves your
saved accounts in place; see [Uninstall and cleanup](#uninstall-and-cleanup).

## First use

```text
/rice-account
```

shows the built-in `login` account (this machine's normal Claude login) and every
saved account, each with its cached email and plan. Pick one with the arrow keys
and Enter; Escape closes the list. Without a graphical surface the same list is
printed as text. `Unknown` means no local metadata was found, `Not signed in`
means no login exists yet. Opening the list makes no network request; run
`/rice-account check <name>` to verify a login with Anthropic.

### Add another account

1. In Claude Code:

   ```text
   /rice-account add personal
   ```

   This saves the name (kind `claudeai`, a separate claude.ai sign-in) and prints
   one terminal command containing this installation's exact paths.

2. Paste that command into a terminal on the same machine (inside the same WSL
   distribution for WSL). The helper checks prerequisites, opens the browser
   login and verifies the account. Useful flags, appended to the command:

   | Flag | Use |
   | --- | --- |
   | `--manual --email you@example.com` | Print a sign-in URL instead of opening the default browser, so you can open it in the browser that holds the right account. |
   | `--browser <executable>` | Have Claude open a specific browser (not combinable with `--manual`). |
   | `--login` | Sign in again even if a valid login is found. |

3. Back in Claude Code, check it and switch:

   ```text
   /rice-account check personal
   /rice-account personal
   ```

If setup stops halfway, `/rice-account setup personal` prints the command again.

For a long-lived setup token instead of a browser login:

```text
/rice-account add ci-token claudeai-token
```

The helper runs `claude setup-token` and asks you to paste the token into a hidden
prompt in the terminal. Never type a token into Claude Code itself.

### Account names

1 to 40 characters from `A-Z a-z 0-9 . _ -`, starting with a letter or digit.
Names must be unique ignoring case, must not end with a dot, must not be a
Windows device name (`con`, `nul`, `com1`, ...), and must not be a command word
(`list`, `use`, `setup`, ...) or an object key such as `toString`. An account that
already had a now-reserved name keeps working: reach it with
`/rice-account use <name>`.

## Commands

| Command | Result |
| --- | --- |
| `/rice-account` | Open the account list (text list where no list can be shown). |
| `/rice-account <name>`, `/rice-account use <name>` | Switch this session. `login` is the machine login. `use` also reaches an account named like a command. |
| `/rice-account list` | Text list of saved accounts with email and plan. |
| `/rice-account usage` | The session account's usage limits. |
| `/rice-account check [name]` | Verify a login with Anthropic (default: the session account). |
| `/rice-account add <name> [kind] [label=...] [service=...]` | Save an account and print its setup command. Kinds: `claudeai` (default), `claudeai-token`. |
| `/rice-account setup <name>` | Print a saved account's setup command again. |
| `/rice-account remove <name>` | Remove it from `accounts.json`. Its login is kept; sessions already using it keep it until they switch. |
| `/rice-account default`, `set-default <name>` | Switch to, or change, the saved default. New sessions still start on the machine login. |
| `/rice-account setup-native` | Withdrawn. Prints how to delete 0.3.0 launcher files by hand. |
| `/rice-account help` | Every subcommand. |

`/usage` and interactive `/status` report the session account while you have
selected one (the engine would report the machine account). Back on the machine
login they are the engine's own again. The status entry shows the session
account's name, email, plan and usage windows.

## What the selected account does

- **Requests.** The session's model requests use the account's bearer token. It
  is carried in `ANTHROPIC_CUSTOM_HEADERS`, the supported request-header
  override, set only in the running Claude process.
- **Children.** Anything the session starts (Bash commands, hooks, MCP servers,
  `claude -p`) inherits that variable like any other `ANTHROPIC_*` setting, so a
  `claude` started from Bash uses the selected account. **Any process in the
  session can therefore read the token.** There is no separate relay variable and
  no file.
- **Commands run exactly as you typed them.** Rice Accounts does not rewrite Bash
  commands or child environments, so your permission rules match as usual.
- **Other plugins.** A plugin that asks for the session's authorization gets an
  opaque handle, usable only for `https://api.anthropic.com` and only by that same
  plugin, never while nonessential network traffic is disabled.
- **Gateways.** If the session was started with a custom `ANTHROPIC_BASE_URL`,
  requests (and the account's token) go to that host; switching tells you so.
- **Not confirmed means locked.** If a switch cannot be verified or undone, the
  status line shows "account not confirmed" and model requests, compaction,
  subagents, web tools and child `claude` runs are refused until you run
  `/rice-account login` or select an account again. The unconfirmed token is
  replaced by one no server accepts, so requests that no plugin hook sees (the
  permission classifier, titles, MCP servers) fail instead of using the wrong
  account. The lockout survives a plugin reload and `/clear`. A prompt you type
  while locked is refused at once with the reason and leaves no row in the
  conversation; messages the engine generates itself (task notifications,
  scheduled runs) are answered with the same reason.
- **`/clear` plus a reload.** When you clear a conversation that has a selected
  account, the plugin keeps a short-lived, non-secret note of the account name in
  its own store (never in the environment, so children cannot inherit it). A
  reload that follows locks the session instead of mistaking the still-selected
  account's header for your launch login.
- **Renewals.** Expiring browser logins are renewed automatically in the
  background (and before a turn that starts after expiry), with backoff after a
  failure. A running session keeps working if you remove its account elsewhere.
- **A new session** always starts on your machine login; select an account
  explicitly in each session.

Native panels that read Claude's internal cached identity directly (outside
`/usage`, interactive `/status` and the status entry) can still show the machine
account.

### Limits

- Anthropic requests identify as `claude-cli/<version> (external, cli)`. `session.usage`
  lists only the five-hour and weekly windows the engine declares; a model's own
  window appears in `/rice-account usage` and the status entry.
- A switch is refused, with the cause and the fix, when Claude Code's own credential
  would override the selected account: an `apiKeyHelper` setting from any settings
  source, an API key passed through `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, workload
  identity federation (`ANTHROPIC_FEDERATION_RULE_ID` with `ANTHROPIC_ORGANIZATION_ID`),
  or a session not started signed in with a Claude subscription. Settings that cannot
  be read refuse it too. `login`, `list`, `check` and `usage` keep working, and an
  account already selected stays in effect.
- An `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or provider selector at launch does not
  block a switch when the session is also signed in with a Claude subscription: the
  switch clears them for this session, and `/rice-account login` restores them.
- The values your session started with (an API key, a launch `CLAUDE_CODE_OAUTH_TOKEN`,
  provider settings) are kept in the session's plugin state so `/rice-account login`
  can restore them exactly, even after a reload. Plugin state is readable by every
  plugin in the session, as the environment already is. If you start sessions
  without such variables there is nothing to keep.
- If the selected account cannot be put back after a reload (network down, locked
  keychain), the session stays locked until you select it again rather than guess.
- A `claude` started from a shell is recognized by name (quotes, wrappers, `eval`,
  `env -S` and nested shells are handled); a renamed copy of the binary is not, but
  the replaced token above still stops it from using an unconfirmed account.

## Credentials on each system

| System | Where a `claudeai` login lives |
| --- | --- |
| macOS | Login keychain item `Claude Code-credentials-<8 hex of the login folder>`, account `$USER` (or `claude-code-user`). |
| Linux, WSL, Windows | `<config>/rice-session-accounts/logins/<name>/.credentials.json`, owner-only (0600; owner-only ACL on Windows). |
| Setup tokens | macOS Keychain, Linux Secret Service (`secret-tool`, needs a running keyring) or Windows Credential Manager. |

`<config>` is `~/.claude`, or `CLAUDE_CONFIG_DIR` when set. The isolated login
folders hold only the extra logins; your settings, plugins, skills, hooks and MCP
servers are untouched.

Claude Code can keep a login where Rice Accounts does not read it, and Rice Accounts
then says so instead of reporting the account as signed out. On macOS it falls back to
a plaintext `.credentials.json` in the login folder when the keychain cannot store a
login; unlock the keychain and run the setup command again with `--login`. On Windows
it uses Credential Manager when `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` is set or its
cached `tengu_windows_credman` setting is on in that folder's `.claude.json`; use a
`claudeai-token` account there.

**A renewed login is never lost.** The server rotates the refresh token on every
renewal, so the new login is first written to a private `.credentials.json.rice-pending`
file (and kept in memory), then saved, then the file is removed. If saving fails
(antivirus holding the file, full disk, locked keychain) the file is kept and is
saved on the next use. The file records which stored login it continues, so it is
only ever adopted when the store still holds that login; reading never changes
anything, and only a renewal (under its lock) promotes or removes a pending file,
and removes only one it wrote itself. So a session that stalls between its
write-ahead and its save cannot cost a newer login: the newer renewal is saved
over it. A renewal kept unsaved is saved again after a plugin reload as soon as
the renewal lock is free. On macOS a login too large for the keychain's line
limit is stored without optional keys such as `mcpOAuth`; it is never truncated.
A renewal records the refresh token's expiry (`refreshTokenExpiresAt`) and uses the
login's own OAuth client, as Claude Code does.

Limits of that guarantee: the macOS keychain has no atomic compare-and-swap, so
a sign-in that finishes within milliseconds of a renewal of the same account can
be overwritten (sign it in again); a token request that hangs for more than 10
minutes stops renewing the lock (its answer is still saved if one arrives); and
a power loss right after a renewal can lose the write-ahead copy, because macOS
`fsync` does not flush to the physical disk.

On WSL a config folder under `/mnt/c/...` cannot be made private (Windows drives
ignore Unix modes); setup warns and recommends a Linux-side folder.

## Network and privacy

Rice Accounts contacts only Anthropic: `https://api.anthropic.com` (usage and
profile lookups) and `https://platform.claude.com` (token renewal). It sends no
analytics. Secrets never appear in command lines, logs or toasts, and the helper
reads tokens only from hidden prompts or stdin.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `/rice-account` is unknown | Confirm the plugin is installed and enabled, then restart Claude Code. |
| Setup says `claude` or Node is missing | Install Node.js 22+ and make `claude` available in that terminal, or set `RICE_ACCOUNTS_CLAUDE` to its absolute path. On WSL use a Linux Node. |
| "account not confirmed" | Run `/rice-account login`, or select a saved account again. |
| The account is saved but not signed in | Run `/rice-account setup <name>` and execute the printed command. |
| Browser login used the wrong account | Re-run setup with `--login --manual --email intended@example.com` and open the URL in the intended browser. |
| A copied setup command stopped working after an update | The command embeds the installed plugin path; run `/rice-account setup <name>` again. |
| A native panel shows the machine account | Use the status entry, `/usage` or interactive `/status`. |
| `/status` is unavailable in print mode | Claude rejects it before plugins run in print mode; use `/usage`. |
| A Linux setup-token account says `secret-tool` is missing | `sudo apt-get install libsecret-tools` (Debian/Ubuntu) and a running Secret Service; or use a `claudeai` browser account. |
| Windows: ConstrainedLanguage or path-length errors | The helper names the cause; use a shorter profile path or a full-language PowerShell. |

## Uninstall and cleanup

`claude plugin uninstall rice-session-accounts@rice-mods` removes the plugin only.
To remove saved data as well, in `<config>/rice-session-accounts/`: delete
`accounts.json` and `logins/` (sign each login out first with the command
`/rice-account remove <name>` prints), and remove any `rice-session-accounts`
entries from your OS credential manager. If you used 0.3.0, run
`/rice-account setup-native` for the launcher files to delete by hand.

## Files

- `rice-session-accounts/accounts.json` - account names, kinds and credential references.
- `rice-session-accounts/logins/<name>/` - each browser account's isolated login folder.
- `rice-session-accounts/locks/` - renewal locks shared by sessions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adapted from
[simplecore-inc/claude-mods](https://github.com/simplecore-inc/claude-mods) (MIT);
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Release history is in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). The adapted code keeps its own MIT notice in
[LICENSES/](LICENSES/).
