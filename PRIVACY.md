# Agent Pulse Privacy

Version: 3.3.1 (independent distribution and Mac App Store edition)
Updated: October 15, 2026
Provider: Doonutsaur Games LLC

Agent Pulse runs locally on macOS. The app has no account system, telemetry, advertising, cloud synchronization, or analytics SDK. It does not upload prompts, conversations, source code, project files, or approval content to the developer.

## Mac App Store edition

The store edition runs in App Sandbox. You grant access to Codex logs or Claude project logs through the macOS folder picker. Local security-scoped bookmarks restore that access after restarting. The Claude Desktop model metadata folder requires a separate optional grant. An agent without folder access is not monitored. Folder grants, settings, task state, and working time history are stored in the app sandbox container.

Choose **Revoke access** beside an authorized folder to stop reading it and remove its saved bookmark. **Remove integrations** revokes all folder access. Disabling both agents and saving also pauses all log monitoring. Existing working time history is retained, and original agent logs are not deleted.

Launch at login is off by default. Agent Pulse adds a login item only after you enable the setting and save. You can turn it off at any time. The app does not automatically re-enable a login item disabled in System Settings. Monitoring continues when the settings window closes; choose **Quit** in the menu bar to stop monitoring and exit.

The store edition connects to Stream Deck Neo over USB. Task execution and approvals take place in the original agent apps. It does not install Claude hooks, launch Managed Codex, execute project verification commands, or control approvals through cross-app keyboard events. Project paths are used only for display labels. Communication between monitoring and the device is in process; this edition does not open TCP listeners.

The following Managed Codex, hook, verification, and independent data folder details apply to the independently distributed edition.

## Local access in the independent edition

When you enable an integration, the app may access:

- A Stream Deck Neo connected by USB.
- Saved Codex task records in `~/.codex`.
- Claude settings and task records in `~/.claude`.
- Selected project folders for labels, opening tasks, and optional verification commands.
- Settings, task state, managed thread registration and queues, the local IPC token, and logs in `~/Library/Application Support/streamdeck-supervisor`.

Observer mode parses records already saved locally by the agents. Managed Codex starts a separate local `codex app-server` stdio process on demand. Requests use your existing Codex service account, permissions, and sandbox settings. Agent Pulse does not receive your Codex or Claude API keys or enable automatic approval.

Managed prompts, queued messages, and bounded current-turn progress snapshots are stored only in the local `managed-codex.json` file with `0600` permissions. Progress text is redacted before persistence. Prompts and queued messages are not sent to Stream Deck. The device receives redacted short activity summaries, plan step counts, subagent counts, durations, and completion recaps. It does not display original prompts, complete commands, or tool parameters. Recaps come from the last valid agent message; no separate model request is made to generate them.

Local IPC listens only on `127.0.0.1` and uses a random token in a file with `0600` permissions. The device protocol does not include approve, reject, or interrupt actions. Approvals, free-text questions, model settings, and interruptions are routed through the internal Electron bridge, which rechecks ownership, agent, thread, turn, item, request, and capabilities. The Claude hook decision channel and Codex keyboard control service are for desktop use.

## Working time

Agent Pulse records working time while it observes an agent running. Parallel tasks for the same agent are counted once in that agent's daily total; individual task durations are tracked separately. Approvals, paused work, sleep, and app downtime are not reconstructed as working time. History is organized by local calendar dates and stored on your Mac. This is observed agent activity, not token usage, billing, or a measurement of model compute time.

## Logs and diagnostics

Operational logs record service state, device connections, and action results. They should not contain prompts or credentials. Task titles, recaps, approval targets, verification output, Git diff logs, and diagnostics redact common API keys, bearer tokens, passwords, private keys, and authorization headers. Verification subprocesses exclude environment variables whose names contain TOKEN, SECRET, PASSWORD, API_KEY, PRIVATE_KEY, or CREDENTIAL by default.

Diagnostics are exported only when you request them. You choose whether to share the ZIP file. Source-build bug reports and suggestions belong in this repository's GitHub Issues. Information posted in a public issue is public; use synthetic examples and do not attach credentials, private conversations, personal contact details, or unredacted diagnostics.

## Removing data

In the store edition, **Remove integrations** disables launch at login, revokes all log folder access, and releases Neo. Settings, working time history, and operational logs are stored under the macOS app sandbox container at `~/Library/Containers/com.shaun-wang.streamdeck-ai-supervisor/Data/Library/Application Support/`. After quitting, you can delete the Agent Pulse data folder there to remove local history.

In the independent edition, **Remove integrations** removes the login item, app-installed Claude hooks, and legacy LaunchAgents, then returns Neo to the Stream Deck app. Settings, task registration and queues, and logs are retained by default. You can subsequently remove `~/Library/Application Support/streamdeck-supervisor`.

Removing Agent Pulse data does not delete the original Codex or Claude conversations. Information you publish on GitHub is handled under GitHub's terms and privacy policy; deleting local app data does not remove it.

## Third-party services and official App Store support

Codex, Claude, Apple, and Elgato services are governed by their own terms and privacy policies. Agent Pulse is independent software and is not affiliated with or endorsed by OpenAI, Anthropic, or Elgato.

The source-available project does not offer email customer support. Customers of the official App Store edition can use the support link on the [App Store listing](https://apps.apple.com/app/id6815483068). That official support website publishes its own contact details and privacy policy. Information sent through that channel is used to respond to the request; use the same channel to request deletion of previously submitted information.

The official support website is hosted by Cloudflare, without added advertising, analytics scripts, or tracking cookies. Cloudflare may process network request information to deliver and secure it; see [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/).
