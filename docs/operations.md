# Operations

Common commands:

```bash
poke setup
poke start
poke status
poke logs --follow
poke restart
poke stop
poke-doctor
```

Backups:

```bash
poke backup create manual
poke backup list
poke backup restore ~/.poke/backups/backup-YYYY-MM-DD
```

`poke update` creates a pre-update backup, pulls with `--ff-only`, installs dependencies, runs migrations, and restarts the daemon.

For systemd, copy `deploy/poke.service` to `/etc/systemd/system/poke.service`, adjust paths if needed, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now poke
```
