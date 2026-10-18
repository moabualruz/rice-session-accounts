# Changelog

## 0.6.0

Closer to the native flow: what the engine already reports is no longer replaced,
and a refusal no longer leaves a made-up turn in the conversation.

### Fixed
- **Windows:** the Credential Manager check uses Claude Code's
  `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` (the old name did nothing) and its cached
  `tengu_windows_credman` setting, in the plugin and in setup.
- **macOS:** a login left in the plaintext fallback file is named with its fix, not
  shown as signed out.
- **Renewals** update `refreshTokenExpiresAt` and use a login's own `clientId`, as
  Claude Code does.
- **Usage, profile and token requests** send Claude Code's User-Agent;
  `session.usage` matches the engine's declared kinds and precision.
- **A switch that could not take effect is refused up front** instead of being
  reported as in effect. Under an `apiKeyHelper`, an API key from
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, workload identity federation, or a session
  not signed in with a Claude subscription, Claude Code's own credential replaced
  the selected bearer or dropped the OAuth beta it needs (measured against the
  shipped binary). The message names the cause and the fix and nothing is changed.
- **Locked sessions leave no fake turn.** A prompt typed while the account is
  not confirmed is dropped at `prompt.submit` with the reason. Before, the refusal
  was written into the conversation as an assistant turn that the next real request
  carried. Requests no typed prompt starts are still answered by `turn.step`.
- **`/usage` and `/status` are the engine's own again on the machine login.**
  They stayed replaced for the rest of the session once any account had been
  reported, including after `/rice-account login`, where the engine's panels are
  right and carry fields the replacement dropped (login method, setting sources,
  session id, base URL, provider).

## 0.5.0

Behaves like native Claude flows: nothing about a tool call or a child process is
rewritten, failures are visible and closed, and a renewed login is never lost.

### Changed
- **No command rewriting.** Bash commands and child environments are no longer
  modified, and the `RICE_SESSION_ACCOUNTS_OAUTH_RELAY` variable is gone. Before,
  every Bash command was prefixed with an `export`, which made allow rules such as
  `Bash(printf:*)` stop matching (the command was refused or prompted) whenever a
  token was present. The selected bearer now travels only in
  `ANTHROPIC_CUSTOM_HEADERS`, which Claude's children inherit, so a `claude`
  started from Bash still uses the selected account. A launch
  `CLAUDE_CODE_OAUTH_TOKEN` is no longer copied into children.
- A custom `ANTHROPIC_BASE_URL` is named when you switch, since that host receives
  the account's token.
- The account list shows each account once (it was listed twice on terminals).
- `/rice-account` has `help`, `use <name>`, complete autocomplete and argument
  validation; messages are consistent. Removing an account no longer breaks
  sessions already using it.

### Fixed
- A rotated refresh token is written ahead of the store and kept in memory, so a
  failed save (antivirus lock, full disk, keychain prompt) no longer destroys the
  login. Windows renames are retried; leftovers from killed writes are recovered.
- macOS: a login too large for `security -i` is reduced (optional keys only) and
  refused before the token is spent, never truncated.
- The renewal lock stays valid for a slow renewal (heartbeat, 150 s, for at most
  10 minutes of a hanging request) and macOS re-reads before writing.
- A pending renewal is adopted only while the store still holds the login it
  continues, and removed only by the renewal that wrote it, so a session that
  stalls mid-renewal cannot cost a newer login. An unsaved renewal is saved
  again after a plugin reload when the lock is free, and found even while the
  store cannot be read.
- Reload safety: the unconfirmed-account lockout and the observed authorization
  handles survive plugin reload and `/clear`; a failed restore now locks the
  session instead of reporting the machine login while using another account.
- Lockout also covers compaction, subagent spawn, web tools and child `claude`.
  An unconfirmed token is replaced by one no server accepts, so requests no hook
  sees fail instead of using the wrong account. `/clear` followed by a reload no
  longer mistakes a selected account's header for the launch login (a short-lived
  non-secret note in the plugin's own store names the account).
- An explicit selection made while a restore waits is no longer undone by it.
- The `claude` detector reads shell keywords, `eval`, redirections, quoting,
  `env -S` and nested shells; host refusal text is redacted; an unknown
  authorization handle is reported as unknown, not foreign.
- Usage is fetched for the main loop only, at most once a minute, and is shown
  stale instead of blank on failure. A committed switch is never reported failed.
- Windows: setup finds an npm-installed `claude` (`.cmd` shim); credential helper
  processes run from a trusted folder; unprotected login folders are repaired;
  distinct errors for path length, ConstrainedLanguage and access denied.
- Setup: friendly message on Node older than 22 (the entry is ES5); the login
  folder must be the derived one; correct quoting for bash, zsh, fish, PowerShell
  (including curly quotes) and cmd; a WSL config folder on a Windows drive warns.
- Account names: case-insensitive uniqueness, Windows device names and command
  words reserved, prototype keys such as `toString` handled; existing accounts
  with now-reserved names keep working through `use`.
- Errors name the cause (timeout, missing program, old Node, Windows `node.exe`
  from WSL, held file, full disk) instead of one generic message.

### Removed
- The withdrawn 0.3.0 launcher code (`native/`), its proofs, tests and notes. They
  were never executed by the plugin but shipped in the installed copy.

### Project
- CI runs on pull requests, macOS, Linux (Claude Code 2.1.296 to 2.1.302) and
  Windows; types are checked; the dash policy covers every tracked text file.
- New real-binary proofs: allow-ruled Bash commands run unmodified with an
  account selected, and a child `claude` sends the selected bearer.
- `CONTRIBUTING.md` documents the checks and the release procedure.

## 0.4.1
Windows renewal lock without `/bin/sh`; `/usage` and `/status` stay on the
selected account when its report fails; `add`, `remove` and `set-default` refuse to
overwrite an `accounts.json` that does not parse; `uname` fallbacks; Windows
identity from `USERPROFILE`; refresh errors no longer quote response text.

## 0.4.0
Account switching through the public plugin API in ordinary `claude`: selected
account in `/usage`, interactive `/status` and a status entry; machine login
restored on request; recovery from refused credential or state changes.

## 0.3.0
Native account usage refresh and managed launchers. The launcher design was
withdrawn in 0.4.0.

## 0.2.0
Rice Accounts manages Anthropic OAuth accounts only; account picker, `add`/`setup`
flow, and mid-session switching.
