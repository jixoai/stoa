# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting:

- Repository → **Security** tab → **Report a vulnerability** (GitHub Security Advisories).

We will acknowledge receipt within a few days and coordinate a fix and disclosure window
with you.

## Scope notes

- Stoa's backend is meant to run **locally** by default (loopback). Exposing it publicly is
  an operator decision: put it behind TLS and enable authentication (`STOA_AUTH`).
- Credentials live in env files (`STOA_TOKEN_<ACCOUNT>`, `<data-dir>/accounts/<id>.env`).
  Never place a data directory under a static file root.
- The MCP face (`stoa mcp`) and adapters never print credentials; report any path that does.
