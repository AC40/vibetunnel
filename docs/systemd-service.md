# VibeTunnel Systemd Service Commands

Quick reference for managing the VibeTunnel systemd service on Linux.

## Initial Setup (one-time)

If you haven't installed the service yet:

```bash
vibetunnel systemd install
```

This creates a user-level systemd service for your account.

## Common Commands

### Start the service
```bash
systemctl --user start vibetunnel
```

### Stop the service
```bash
systemctl --user stop vibetunnel
```

### Restart the service
```bash
systemctl --user restart vibetunnel
```

### Check status
```bash
systemctl --user status vibetunnel
```

### View logs (live)
```bash
journalctl --user-unit=vibetunnel -f
```

### View recent logs (last 50 lines)
```bash
journalctl --user-unit=vibetunnel -n 50
```

### Enable auto-start on login
```bash
systemctl --user enable vibetunnel
```

### Disable auto-start
```bash
systemctl --user disable vibetunnel
```

## Notes

- `--user` runs the service in user space (not system-wide)
- Logs are in the user journal; use `journalctl --user-unit=vibetunnel` to view
- Service runs under your user account, so it respects your PATH and environment
