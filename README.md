# rice-session-accounts

A Claude Code mod that keeps several Anthropic accounts and switches **one
session** between them. Every session starts on this machine's own `/login`.
`/rice-account <name>` moves only the current session: its main loop, its subagents
and any `claude -p` it starts after the switch. Other sessions keep their own
account.

It works by setting Claude Code's own credential variables
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK`, ...) inside this session's process, which Claude Code
reads on every request. The machine's shared login is never written.

## Account kinds

| Kind | What it uses | One-time setup (in a terminal) |
| --- | --- | --- |
| `login` | this machine's `/login` (built in) | none |
| `claudeai` | a separate claude.ai sign-in (Pro, Max, Team, Enterprise), renewed by the mod | `CLAUDE_CONFIG_DIR="<folder>" claude auth login --claudeai` |
| `claudeai-token` | a one-year token from `claude setup-token` | `claude setup-token`, then store it in the keychain |
| `api-key` | a Console API key | `security add-generic-password -U -s rice-session-accounts -a <name> -w` |
| `gateway` | an Anthropic-compatible gateway (`base_url=`) and its token | as `api-key` |
| `bedrock` | an AWS profile (`aws_profile=`, `region=`), or a Bedrock API key (`secret=bearer`) | `aws sso login --profile <p>` |
| `vertex` | a GCP project (`project=`, `region=`) | `gcloud auth application-default login` |
| `foundry` | an Azure Foundry resource (`resource=` or `base_url=`), Azure login or `secret=key` | `az login` |

`/rice-account add <name> <kind> [key=value ...]` saves the account and prints the
exact setup command. Secrets are typed into the keychain prompt, never into a
Claude Code session.

## Commands

- `/rice-account` lists the accounts and marks this session's.
- `/rice-account <name>` switches this session; `/rice-account login` or `/rice-account default` switches back.
- `/rice-account usage` shows the 5-hour and weekly windows of a claude.ai account.
- `/rice-account check [name]` verifies a saved credential.
- `/rice-account add`, `/rice-account remove <name>`, `/rice-account set-default <name>`.

## Files

- `~/.claude/rice-session-accounts/accounts.json`: names and kinds, no secrets.
- `~/.claude/rice-session-accounts/logins/<name>/`: the folder a `claudeai` account
  signs in; its login lives in the keychain item Claude Code names for that folder.
- Keychain service `rice-session-accounts`: tokens and keys saved by name.

A per-account `models` map in `accounts.json` renames model ids for that
account (for example a Bedrock inference profile).

Adapted from [simplecore-inc/claude-mods](https://github.com/simplecore-inc/claude-mods)
(MIT); see `THIRD_PARTY_NOTICES.md`.
