# essential

`essential` is a deliberately small collection of inspectable POSIX shell
tools for Linux, plus the Cloudflare Worker that publishes an explicit
allowlist at [raw.xinu.my.id](https://raw.xinu.my.id/). It is not a package
manager and the Worker is not a general-purpose GitHub proxy.

The current tools are:

| Tool | Purpose | Important behavior |
| --- | --- | --- |
| [`cinit`](tools/cinit) | Disable an installed `cloud-init` on a systemd host | Creates a disable flag and network policy, then disables and masks detected `cloud-init` units. It backs up prior state first. |
| [`sudo`](tools/sudo) | Install `sudo` and grant one regular account administrator access | Supports `apt-get`, `dnf`, `pacman`, and `apk`; validates sudoers with `visudo`; refuses to guess if several regular users exist. |

The Worker accepts only `/cinit`, `/sudo`, and
`/v/<40-character-commit-SHA>/<name>`. Both `meta.json` and the matching tool
are fetched at the same ref. Mutable responses are cached for five minutes;
commit-addressed responses are cached for one year with `immutable`.

## Supported operating systems

These are shell tools for Linux. The table separates intended compatibility
from the repository's mock-based automated tests; test on a disposable host
before changing an important machine. Windows is not supported.

| Linux family | `sudo` | `cinit` | Notes |
| --- | --- | --- | --- |
| Debian / Ubuntu | Yes | Yes | `cinit` requires systemd, `/etc/cloud`, and the `cloud-init` executable. |
| Fedora / RHEL family | Yes | Compatible | Uses the `wheel` group. `cinit` has the same systemd and `cloud-init` requirements. |
| Arch Linux | Yes | Compatible | Uses `pacman` and `wheel`; update a stale package database manually if `pacman -S --needed sudo` refuses. |
| Alpine Linux | Yes | No | `sudo` uses `apk` and `wheel`; the normal Alpine OpenRC environment does not satisfy `cinit`'s systemd requirement. |
| Other systemd Linux distributions | Package-manager dependent | Compatible | `sudo` needs one of the four supported package managers. `cinit` detects installed units rather than assuming all four exist. |

## Read and inspect first

Review the repository copy before running anything:

```sh
git clone https://github.com/x-inu/essential.git
cd essential
git status --short
git log -1 --show-signature --format=fuller
cat tools/cinit
cat tools/sudo
sha256sum tools/cinit tools/sudo
```

A SHA-256 match proves byte identity with an expected digest; it does not
prove that those bytes are safe for your host. Inspect system calls, paths,
package-manager operations, privilege changes, and rollback behavior yourself.

### Mutable route: download first

The short route follows `main` and can change. It is convenient for reviewing
the latest version, but is not reproducible. This download-first example uses
a subshell so its cleanup trap does not replace a trap in your current shell.
It inspects and syntax-checks the exact temporary file before executing that
same file:

```sh
(
  set -eu
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT HUP INT TERM

  curl --proto '=https' --tlsv1.2 -fsSL \
    https://raw.xinu.my.id/cinit -o "$tmp"
  cat "$tmp"
  sh -n "$tmp"

  printf '\nRun this downloaded cinit in dry-run mode? [y/N] '
  IFS= read -r answer
  case "$answer" in
    y | Y | yes | YES) sh "$tmp" --dry-run ;;
    *) printf '%s\n' 'Not run.' ;;
  esac
)
```

For `sudo`, use `https://raw.xinu.my.id/sudo` and make the final invocation
`sh "$tmp" alice`, replacing `alice` with the intended login account.

### Immutable commit SHA: verify, then run the same bytes

Prefer this method when reproducibility matters. Copy the full lowercase
40-character commit SHA and the tool's 64-character SHA-256 from the index,
then corroborate them against the GitHub commit and source through a trusted
channel. Replace both placeholders below; the validation guards prevent a
partial SHA or malformed digest from being used.

```sh
TOOL=cinit
COMMIT=0123456789abcdef0123456789abcdef01234567
EXPECTED_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

case "$TOOL" in cinit | sudo) ;; *) printf '%s\n' 'Invalid tool' >&2; exit 1 ;; esac
case "$COMMIT" in *[!0-9a-f]*)
  printf '%s\n' 'COMMIT must be exactly 40 lowercase hexadecimal characters' >&2
  exit 1
esac
if [ "${#COMMIT}" -ne 40 ]; then
  printf '%s\n' 'COMMIT must be exactly 40 lowercase hexadecimal characters' >&2
  exit 1
fi
case "$EXPECTED_SHA256" in *[!0-9a-f]*)
  printf '%s\n' 'EXPECTED_SHA256 must be exactly 64 lowercase hexadecimal characters' >&2
  exit 1
esac
if [ "${#EXPECTED_SHA256}" -ne 64 ]; then
  printf '%s\n' 'EXPECTED_SHA256 must be exactly 64 lowercase hexadecimal characters' >&2
  exit 1
fi

(
  set -eu
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT HUP INT TERM

  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://raw.xinu.my.id/v/$COMMIT/$TOOL" -o "$tmp"
  printf '%s  %s\n' "$EXPECTED_SHA256" "$tmp" | sha256sum -c -
  cat "$tmp"
  sh -n "$tmp"

  printf '\nRun these verified bytes? [y/N] '
  IFS= read -r answer
  case "$answer" in
    y | Y | yes | YES) sh "$tmp" --dry-run ;;
    *) printf '%s\n' 'Not run.' ;;
  esac
)
```

The final argument in that example is appropriate for `cinit`. For `sudo`,
replace `--dry-run` with the explicit target username. Verification and
inspection happen against `$tmp`, and `sh "$tmp" ...` executes that same file;
there is no second network fetch between checking and execution.

> **Root warning:** both tools can make system-wide changes. Download and
> inspect as an unprivileged user. Do not run `curl`, the Worker response, or an
> entire interactive shell as root merely to obtain a script. When a change
> needs privilege, a readable local tool requests elevation with existing
> `sudo` and falls back to `su`; piped input is deliberately unable to
> self-elevate.

`curl ... | sh` is therefore **not the primary method and is not recommended**.
It removes the review checkpoint, makes cleanup and byte verification harder,
and cannot safely self-elevate in these tools. Download, inspect, verify, and
only then run a local file.

## Tool usage

### `sudo`

Run from a clone or from a reviewed downloaded file:

```sh
./tools/sudo alice
```

The optional argument is the account to add. Without it, the tool checks
`SUDO_USER`, then `logname`, then the regular accounts in `/etc/passwd` using
the `UID_MIN`/`UID_MAX` range from `/etc/login.defs`. It proceeds automatically
only when the result is unambiguous.

The tool:

1. elevates with an already-installed `sudo` or with `su`;
2. installs `sudo` if necessary;
3. selects `sudo` or `wheel` according to the distribution;
4. validates a candidate policy with `visudo -cf` before installation;
5. validates the complete configuration with `visudo -c`, rolling its policy
   file back if final validation fails; and
6. appends the user to the administrator group and verifies membership.

Log out and back in after success, then verify with:

```sh
sudo -v
sudo -l
```

Never pass an account you have not independently verified with `id USER`.

### `cinit`

Disabling `cloud-init` can prevent a provider from repairing or regenerating
network configuration after reboot. Confirm that the machine has durable,
correct network settings and an out-of-band recovery path first.

```text
Usage: cinit [--yes] [--dry-run]
  --dry-run  inspect detected state and report whether changes are needed
  --yes      skip the mutation confirmation prompt
  --help     print usage
```

Start with:

```sh
./tools/cinit --dry-run
```

An interactive change is `./tools/cinit`; automation may use
`./tools/cinit --yes` only after reviewing a dry run. A successful mutation
creates a unique backup under `/var/backups/essential-cinit.XXXXXXXX/`, records
detected unit states, writes `/etc/cloud/cloud-init.disabled`, writes
`99-disable-network-config.cfg`, and disables/masks each detected unit. An
already-disabled system is a verified no-op and does not create another
backup.

#### `cinit` rollback

The backup path is printed on success and in failure guidance. Keep the
terminal output. Rollback is intentionally manual because the correct service
state depends on the host:

1. inspect `detected-units` and `unit-states` in the printed backup directory;
2. restore `cloud-init.disabled` and `99-disable-network-config.cfg` to their
   original paths when a saved file exists;
3. if a corresponding `.absent` marker exists, remove the file that `cinit`
   created instead of restoring it;
4. run `systemctl unmask UNIT.service` for affected units; and
5. use the recorded state to enable or disable each unit and to start or stop
   it as appropriate (for example,
   `systemctl enable --now cloud-init.service` only when that was the intended
   pre-change state).

Inspect every path before copying as root. Do not blindly enable all four unit
names: `cinit` records and changes only units detected on that host. Reboot only
after checking network configuration and unit state.

## Repository structure

```text
.
├── .github/workflows/ci.yml  # Linux CI: lint, parse, Worker tests, tool tests
├── LICENSE                   # GNU GPL version 3
├── README.md
├── meta.json                 # Exact public metadata allowlist
├── src/index.js              # Cloudflare Worker, routes, hashing, and landing page
├── tests/
│   ├── run.sh                # Python unittest entry point
│   ├── test_posix_tools.py   # Mocked filesystem/admin-command tool tests
│   └── worker.test.js        # Node Worker routing/security/cache tests
├── tools/
│   ├── cinit
│   └── sudo
└── wrangler.toml             # Worker name, entry point, route, and compatibility date
```

`meta.json` is the publication boundary. The Worker validates every key and
source, permits only a matching `tools/<name>` path, and never lists repository
directories recursively.

## Run the Worker locally

Requirements are a current Node.js release with Web APIs used by the Worker
and Wrangler. No application dependency installation is required for the Node
test suite.

```sh
npx wrangler dev
```

Wrangler normally listens on `http://localhost:8787`:

```sh
curl -i http://localhost:8787/
curl -i http://localhost:8787/sudo
```

The local Worker runs the checked-out `src/index.js`, but its normal upstream
fetches still read `meta.json` and tools from `x-inu/essential` on GitHub.
Unpublished local manifest/tool changes are covered by the mocked tests rather
than automatically becoming the Worker's upstream content.

An optional `GITHUB_TOKEN` Worker secret increases authenticated GitHub API
capacity for the landing page commit lookup:

```sh
npx wrangler secret put GITHUB_TOKEN
```

## Tests and checks

The commands used by CI are:

```sh
find tools -maxdepth 1 -type f -print
shellcheck tools/*
shfmt -d tools/*
for tool in tools/*; do dash -n "$tool"; bash -n "$tool"; done
node --check src/index.js
node --test tests/worker.test.js
./tests/run.sh
```

Run the file-count and executable checks from the workflow as well; the short
loop above is for convenience and assumes the repository's nonempty `tools/`
directory. `tests/run.sh` needs Python 3 and uses temporary trees plus mocked
administrative commands; it does not modify the host's real `/etc` or
`/var/backups`.

## Deploy

The production Worker is connected to this repository through Cloudflare
Workers Builds. A reviewed push to `main` triggers the configured build and
deployment. Verify the build in Cloudflare before treating it as complete.
Mutable responses have a five-minute edge cache and query parameters are
intentionally omitted from cache keys. Wait for the TTL, purge the Worker cache,
or verify the immutable route for the deployed commit:

```sh
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT HUP INT TERM
COMMIT=<40-character-deployed-commit-SHA>
curl -fsSL "https://raw.xinu.my.id/v/$COMMIT/cinit" -o "$tmp"
sh -n "$tmp"
```

Maintainers can deploy manually from an authenticated environment when the
GitHub integration is unavailable:

```sh
npx wrangler deploy
```

Manual deployment requires Cloudflare credentials with the least privileges
needed for the `essential-raw` Worker and the `raw.xinu.my.id/*` route. Never
commit API tokens. Deployment changes the Worker code; publishing changed tool
bytes also requires those files and `meta.json` to exist on the referenced
GitHub commit.

## Release and versioning policy

- `main` is the moving development and deployment branch. `/cinit` and `/sudo`
  follow it and are unsuitable as permanent pins.
- The full Git commit SHA is the canonical immutable tool version. The Worker
  requires exactly 40 lowercase hexadecimal characters and loads the manifest
  and tool from that same commit.
- Published Git tags use Semantic Versioning (`vMAJOR.MINOR.PATCH`): incompatible
  command/behavior changes increment MAJOR, backward-compatible tools or
  options increment MINOR, and compatible fixes increment PATCH.
- Tags and released commits are never moved or rewritten. Tool scripts do not
  claim an independent version; identify them by repository tag plus commit SHA.
- Every release must pass CI, document user-visible and privilege/rollback
  changes, and publish SHA-256 values for the exact tool bytes. Consumers should
  retain both the commit SHA and expected SHA-256.
- Emergency fixes use a new commit and version. Immutable URLs continue to
  serve old bytes, so a security notice must identify affected and fixed SHAs.

## Adding a new tool: checklist 1–8

1. Create exactly one lowercase public file at `tools/<name>`; keep the name
   within `[a-z0-9._-]`, with an alphanumeric first and last character.
2. Make it executable (`chmod 0755 tools/<name>`), use
   `#!/usr/bin/env sh`, remain POSIX-compatible, start with `set -eu`, and add a
   line-two `# essential tool: <name>` identity comment followed by
   `# source: https://github.com/x-inu/essential/tree/main/tools`.
3. Design for safe local-file elevation, strict argument validation,
   idempotence where possible, post-change verification, actionable failures,
   cleanup traps, and explicit backup/rollback guidance; never accept an
   unreviewed command payload or use `sh -c` for elevation.
4. Add exactly one `meta.json` object keyed by `<name>` containing only
   `source`, `title`, `kanji`, `note`, `target`, `shell`, and `requires_root`,
   with `source` exactly `tools/<name>`.
5. Confirm the existing Worker route and source validators accept the new
   manifest entry without broadening either validation pattern.
6. Extend `tests/test_posix_tools.py` with success, refusal, elevation,
   idempotence, verification, failure, and rollback cases without touching the
   host, and extend `tests/worker.test.js` for the exact manifest and both
   mutable and immutable routes.
7. Update this README's tool table, Linux support matrix, usage, rollback,
   repository tree, and any security or release notes affected by the tool.
8. Run the complete CI command set locally, review `git diff` and executable
   modes, obtain maintainer review, merge without rewriting history, verify the
   Workers Build, and record the released commit SHA plus SHA-256 digest.

## Security reporting

Do not disclose a suspected vulnerability in a public issue. Use the
repository's private
[GitHub security advisory form](https://github.com/x-inu/essential/security/advisories/new).
Include the affected tool or Worker route, commit SHA, Linux distribution,
reproduction steps, expected and observed behavior, impact, and any proposed
fix. Remove credentials, hostnames, account data, and other secrets from logs.
For an actively compromised machine, isolate and recover the host first; this
project is not an incident-response service.

## License

This project is free software licensed under the
[GNU General Public License, version 3](LICENSE) (`GPL-3.0-only`). The complete
license text is included in `LICENSE`; distributions and modifications must
preserve the applicable GPL source and notice obligations. The software is
provided without warranty as described by the license.
