# Contributing to Agent Pulse

Use this repository's GitHub Issues for bug reports, reproducible examples,
and suggestions. The source project does not provide email customer support
or guarantee a response time. Include your
macOS version, Agent Pulse version, agent, and device model. Use synthetic task
data and redact private information before sharing logs or screenshots.

## Code and asset contributions

Agent Pulse is source-available and also distributed as a paid proprietary app.
The public license alone does not give the maintainer the right to distribute
someone else's contribution under the official app's separate terms.

Before a code or asset contribution is merged, its author and any applicable
rights holder must explicitly agree in writing to a separate contribution
agreement permitting incorporation, modification, and distribution in both
the source-available project and the paid official app. Opening a pull request
does not by itself constitute that additional agreement. Contributions remain
unmerged until this is resolved. Do not submit employer-owned material without
the employer's permission.

This does not prevent sharing your own source fork under the public license.
Do not attach compiled apps, installers, or public CI build artifacts.
Third-party material must include its provenance and applicable license.

## Development

Follow the build commands in [README.md](README.md) and run checks appropriate
to the change. Neo changes need validation for Codex and Claude, rendering,
navigation boundaries, and interaction feedback with synthetic data.
Do not include signing credentials, provisioning profiles, private agent logs,
App Store account screenshots, or local audit reports.

For local data handling and privacy details, see [PRIVACY.md](PRIVACY.md).
Support for official App Store purchases is available through the support link
on the App Store listing.

When changing the project license, keep `LICENSE` and `packages/app/LICENSE`
identical. The app copy is included in locally built application archives.
