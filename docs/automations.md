# Automations

Automations live in `~/.poke/automations.json`.

They support recurring cron schedules and one-time ISO datetime schedules. Actions can be shell commands or agent prompts.

The default seeded automation is weekly memory cleanup:

```json
{
  "name": "Weekly memory cleanup",
  "schedule": { "type": "cron", "value": "0 2 * * 0", "timezone": "Asia/Karachi" },
  "action": { "type": "command", "command": "poke memory cleanup" }
}
```
