# Security Policy

## Supported versions

Security fixes are applied to the latest published release of `@kieksme/mcp-http-kit`.

## Reporting a vulnerability

Please open a private security advisory on
[GitHub](https://github.com/kieksme/mcp-http-kit/security/advisories/new)
or email the maintainers. Do not file public issues for undisclosed vulnerabilities.

## Hardening notes

- Prefer `MCP_AUTH_MODE=bearer` or `oauth` for any non-localhost deployment.
- `MCP_AUTH_MODE=none` is refused unless the process binds to localhost or
  `MCP_AUTH_ALLOW_NONE=true` is set explicitly (intended for public read-only demos).
- Keep `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` tight when binding beyond loopback.
- Never commit bearer tokens or OAuth client secrets; use environment variables / Railway secrets.
