# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in @adhd, please report it responsibly by emailing `security@adhd.dev` instead of using the public issue tracker.

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any proposed fixes

We will acknowledge receipt of your report within 48 hours and work with you to address the issue.

## Security Best Practices

When using @adhd in production:

- Keep all dependencies up to date (`pnpm update`)
- Review the [CHANGELOG.md](CHANGELOG.md) for security fixes in new releases
- Use the versioning strategy in [PUBLISHING.md](PUBLISHING.md) to track updates
- Follow the platform isolation rules in [AGENTS.md §3](AGENTS.md#-3-platform-isolation-environment-rules) to prevent code execution in unsafe contexts

## Supported Versions

The latest version of @adhd receives security updates. Older versions are supported on a best-effort basis.

Check [npm](https://www.npmjs.com/org/adhd) for the latest published versions.
