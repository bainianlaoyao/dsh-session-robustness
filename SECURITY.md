# Security

This plugin does not store API keys. It only reads and writes the
`session-robustness` block in `$DSH_HOME/settings.yaml` (enable / pause /
backoff / extra retry codes).

It does not wrap `ctx.llm.stream()`, does not register model tools, and does
not open outbound sockets of its own. Retries reuse the already-open agent
step and the provider the session was already calling.

It never retries `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `QUOTA`,
or `ABORTED`. A user Stop stays a Stop.

Report issues at https://github.com/bainianlaoyao/dsh-session-robustness/issues
