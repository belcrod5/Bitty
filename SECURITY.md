# Security Policy

## Supported Versions

This project is being prepared for its first public OSS release. Until a public
release is tagged, security fixes are handled on the default branch.

## Reporting A Vulnerability

Please do not open a public issue for suspected secrets, credential exposure,
or private-data leaks.

Report security concerns through GitHub Security Advisories for this repository.
If advisories are not available yet, contact the repository owner privately
through their GitHub profile instead of opening a public issue.

Include:

- affected file or feature
- reproduction steps
- expected impact
- whether any token, local path, or private host information is exposed

## Secret Handling

Do not commit:

- `.env` files
- exported app settings JSON
- runner logs
- OAuth caches
- signing files or provisioning profiles
- private device IDs, LAN IPs, or absolute local paths

The in-app settings export is designed for full device migration and may contain
private values. It must not be used as an OSS default configuration.
