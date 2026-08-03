# Git Authentication

Agentwheel keeps OpenPack manifests portable. Personal GitHub accounts and tokens belong in a
user-local configuration file, not in `openpack.json`, workspace config, lockfiles, or package
metadata.

## GitHub account profiles

Create `~/.agentwheel/auth.json` and map repository patterns to a local `gh` account:

```json
{
  "profiles": {
    "github-yehonal": {
      "provider": "gh",
      "account": "Yehonal",
      "repositories": ["github.com/NestDevLab/*"]
    }
  }
}
```

Repository patterns use the normalized `host/owner/repository` form and support `*` wildcards.
For example, `github.com/NestDevLab/*` matches all repositories owned by `NestDevLab`.

When Agentwheel clones or fetches a matching repository, it invokes:

```text
gh auth token --user Yehonal
```

The resulting token is supplied through a temporary Git credential helper for that operation only.
It is never written to manifests, lockfiles, cache metadata, or logs.

Set `AGENTWHEEL_AUTH_CONFIG` to use a different local configuration file, for example in tests or
an isolated environment:

```bash
AGENTWHEEL_AUTH_CONFIG=/path/to/auth.json agentwheel install
```

Currently supported provider: `gh` (GitHub CLI). The selected account must already be authenticated
with `gh auth login` or an equivalent local credential setup.
