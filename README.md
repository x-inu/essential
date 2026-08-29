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

Because `inet` is interactive and can change the SSH address, download it first:

```sh
curl -fsSL https://raw.xinu.my.id/inet -o /tmp/inet
sudo sh /tmp/inet
```

Inspect the current network or review a non-interactive change without writing:

```sh
sh /tmp/inet --show
sh /tmp/inet --dry-run --interface ens18 --mode static \
  --address 192.168.10.2/24 --gateway 192.168.10.1 \
  --dns 1.1.1.1,8.8.8.8 --metric 100 --mtu 1500
```

Apply complete non-interactive configurations as root:

```sh
sudo sh /tmp/inet --interface ens18 --mode static \
  --address 192.168.10.2/24 --gateway 192.168.10.1 \
  --dns 1.1.1.1,8.8.8.8 --search example.net \
  --metric 100 --mtu 1500 --yes
sudo sh /tmp/inet --interface ens18 --mode dhcp --yes
```

An SSH change remains protected until it is accepted from the new address. The
tool prints the token and backup path after a successful apply:

```sh
sudo /bin/sh /run/essential-inet/inet --confirm <48-character-token>
sudo sh /tmp/inet --rollback /var/backups/essential-inet.XXXXXXXX
```

For reproducible downloads, pin the full commit SHA:

```text
https://raw.xinu.my.id/v/<40-character-commit-SHA>/<tool>
```

These tools can make system-wide changes. Review their source and understand the
requested privileges before running them. The direct commands require a shell
that already has the necessary privileges.

## Verify

```sh
node --test verification/worker_security.test.js
./verification/run_posix_tool_tests.sh
```

## License

[GPL-3.0](LICENSE) · [Report a security issue privately](https://github.com/x-inu/essential/security/advisories/new)
