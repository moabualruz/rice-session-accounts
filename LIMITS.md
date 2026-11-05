# Limits

Rice Accounts switches the account used by the current Claude Code session. It does not change the
machine login or another independently running session. A new top-level session starts with the
machine login and must select an account explicitly. A Claude process launched as a child of a
selected session inherits that session's environment, including the selected bearer header.

## Claude Code behavior

- Claude Code still owns account metadata, plan checks and upgrade prompts, telemetry, and native
  panels that read its cached identity directly. Those can continue to reflect the machine login
  while Rice Accounts has selected another account. `/usage`, interactive `/status`, and the Rice
  Accounts status entry report the selected session account.
- Some Claude Code requests do not pass through plugin hooks, including permission classification,
  titles and MCP servers. When the session is locked because an account switch could not be
  confirmed or restored, those requests fail with Claude Code's invalid bearer token response.
  Select an account again with `/rice-account login` or another saved account.
- A switch is refused if Claude Code's own credential sources would override it, including an
  `apiKeyHelper`, an API key provided through `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, workload
  identity federation, an unreadable settings source, or a session not signed in with a Claude
  subscription.
- Anthropic requests identify as `claude-cli/<version> (external, cli)`. `session.usage` exposes the
  five-hour and weekly windows Claude Code declares; model-specific usage windows are available
  through `/rice-account usage` and the status entry.

## Credential and network boundaries

- A selected account's bearer token is carried in `ANTHROPIC_CUSTOM_HEADERS` in the running Claude
  process. Child processes inherit that environment, so any process in the session can read the
  token.
- If the session starts with a custom `ANTHROPIC_BASE_URL`, requests and the selected account's token
  go to that host. Rice Accounts does not replace or proxy the configured gateway.
- Other plugins can request an opaque authorization handle. It is usable only by the requesting
  plugin, only for `https://api.anthropic.com`, and only while nonessential network traffic is
  enabled.
- If the selected login cannot be restored after a reload, such as when the network is unavailable
  or the keychain is locked, the session remains locked until an account is selected again. Rice
  Accounts does not guess which account is active.

## Platform and process recognition

- Credential storage follows the host platform: macOS uses Keychain when available; Linux and
  Linux-side WSL config directories use owner-only credential files for browser logins and Secret
  Service for setup tokens; Windows uses owner-only credential files for browser logins and
  Credential Manager for setup tokens. A credential store that Claude Code or the operating system
  does not expose to Rice Accounts may make that login appear unavailable. On WSL, a config
  directory under `/mnt/c/` cannot be made private because Windows drives ignore Unix permission
  modes; setup warns and recommends a Linux-side config directory.
- If the macOS keychain cannot store a browser login, Rice Accounts falls back to a plaintext
  `.credentials.json` in that login's folder. Unlock the keychain and repeat setup with `--login`
  to store it in Keychain.
- Shell-started Claude processes are recognized by executable name, including common quoting,
  wrappers and nested shells. A renamed copy of the Claude executable is not recognized. In an
  unconfirmed session, the replacement token still prevents that process from using the unconfirmed
  account.

## Native account picker

The picker is a host-native pane, not an HTTP or MCP API; it adds no OpenAPI server or React runtime.
It loads account names when opened and account details and usage only for the visible page. The page
starts at 50 accounts, grows to at most 64 on surfaces with a native Select control and 200 on
Button surfaces, then moves through larger inventories in user-requested windows. Search filters
the names. Results from a superseded picker revision are ignored, although an in-flight read may
finish. Large synthetic fixtures cover a 500-account inventory and bounded detail reads; they do
not qualify physical keyboard or Escape behavior on every host surface.
