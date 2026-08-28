# raw.xinu.my.id

A small, explicit allowlist of inspectable Linux tools, served from the edge.

[Open the tool index](https://raw.xinu.my.id/) · [Source](https://github.com/x-inu/essential)

## Tools

| Tool | Purpose | Latest |
| --- | --- | --- |
| `sudo` | Install sudo and grant an existing user administrative access | [View](https://raw.xinu.my.id/sudo) |
| `cinit` | Disable cloud-init while preserving the previous configuration | [View](https://raw.xinu.my.id/cinit) |

Only `/sudo`, `/cinit`, and immutable version URLs are public. This service is
not a general-purpose GitHub proxy.

## Use

Run a published tool from its direct route:

```sh
curl -fsSL https://raw.xinu.my.id/cinit | sh
curl -fsSL https://raw.xinu.my.id/sudo | sh
```

For reproducible downloads, pin the full commit SHA:

```text
https://raw.xinu.my.id/v/<40-character-commit-SHA>/<tool>
```

Both tools can make system-wide changes. Review their source and understand the
requested privileges before running them. The direct commands require a shell
that already has the necessary privileges.

## Verify

```sh
node --test verification/worker_security.test.js
./verification/run_posix_tool_tests.sh
```

## License

[GPL-3.0](LICENSE) · [Report a security issue privately](https://github.com/x-inu/essential/security/advisories/new)
