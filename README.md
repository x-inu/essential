# raw.xinu.my.id

A small, explicit allowlist of inspectable Linux tools, served from the edge.

[Open the tool index](https://raw.xinu.my.id/) · [Source](https://github.com/x-inu/essential)

## Tools

| Tool | Purpose | Latest |
| --- | --- | --- |
| `sudo` | Install sudo and grant an existing user administrative access | [View](https://raw.xinu.my.id/sudo) |
| `cinit` | Disable cloud-init while preserving the previous configuration | [View](https://raw.xinu.my.id/cinit) |
| `inet` | Safely configure IPv4 networking with automatic rollback | [View](https://raw.xinu.my.id/inet) |

Only manifest-listed routes such as `/sudo`, `/cinit`, `/inet`, and their
immutable version URLs are public. This service is
not a general-purpose GitHub proxy.

## Use

Run a published tool from its direct route:

```sh
curl -fsSL https://raw.xinu.my.id/cinit | sh
curl -fsSL https://raw.xinu.my.id/sudo | sh
```

## License

[GPL-3.0](LICENSE) · [Report a security issue privately](https://github.com/x-inu/essential/security/advisories/new)
