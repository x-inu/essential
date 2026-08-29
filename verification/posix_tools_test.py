#!/usr/bin/env python3
"""Verify POSIX tools using temporary etc/var trees and fake admin commands."""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SUDO_TOOL = REPO / "tools" / "sudo"
CINIT_TOOL = REPO / "tools" / "cinit"
INET_TOOL = REPO / "tools" / "inet"

DISPATCHER = r'''#!/bin/sh
set -eu
name=${0##*/}
log=${MOCK_LOG:?}
state=${MOCK_STATE:?}
root=${ESSENTIAL_TEST_ROOT:?}
printf '%s' "$name" >>"$log"
for arg in "$@"; do printf ' <%s>' "$arg" >>"$log"; done
printf '\n' >>"$log"
case "$name" in
id)
  if [ "${1:-}" = -u ] && [ "$#" -eq 1 ]; then printf '%s\n' "${MOCK_EUID:-0}"; exit 0; fi
  if [ "${1:-}" = -u ]; then awk -F: -v n="$2" '$1 == n { print $3; found=1 } END { exit !found }' "$root/etc/passwd"; exit; fi
  if [ "${1:-}" = -nG ]; then
    [ -f "$state/$2.groups" ] && cat "$state/$2.groups" || printf '%s\n' "${MOCK_GROUPS:-users}"
    exit 0
  fi
  awk -F: -v n="${1:-}" '$1 == n { found=1 } END { exit !found }' "$root/etc/passwd"
  ;;
getent)
  if [ "$1" = passwd ]; then awk -F: -v n="$2" '$1 == n { print; found=1 } END { exit !found }' "$root/etc/passwd"; fi
  if [ "$1" = group ]; then awk -F: -v n="$2" '$1 == n { print; found=1 } END { exit !found }' "$root/etc/group"; fi
  ;;
logname) [ -n "${MOCK_LOGNAME:-}" ] || exit 1; printf '%s\n' "$MOCK_LOGNAME" ;;
sudo)
  if [ "${1:-}" = -v ]; then [ "${MOCK_SUDO_FAIL:-0}" = 0 ]; exit; fi
  MOCK_EUID=0; export MOCK_EUID
  exec "$@"
  ;;
su)
  [ "${MOCK_SU_FAIL:-0}" = 0 ] || exit 1
  [ "${1:-}" = -s ] && shift 2
  [ "${1:-}" = root ] && shift
  [ "${1:-}" = -- ] && shift
  MOCK_EUID=0; export MOCK_EUID
  exec "$@"
  ;;
apt-get|dnf|pacman|apk)
  [ "${MOCK_PACKAGE_FAIL:-0}" = 0 ] || exit 1
  if [ "$name" != apt-get ] || [ "${1:-}" = install ]; then
    ln -sf "$MOCK_DISPATCHER" "$MOCK_BIN/sudo"
    ln -sf "$MOCK_DISPATCHER" "$MOCK_BIN/visudo"
  fi
  ;;
visudo)
  case "${2:-}" in */.candidate.*) [ "${MOCK_VISUDO_FAIL_CANDIDATE:-0}" = 0 ] ;; *) [ "${MOCK_VISUDO_FAIL_FINAL:-0}" = 0 ] ;; esac
  ;;
groupadd) printf '%s:x:10:\n' "$1" >>"$root/etc/group" ;;
usermod) printf '%s %s\n' "${MOCK_GROUPS:-users}" "$2" >"$state/$3.groups" ;;
addgroup)
  if [ "${1:-}" = -S ]; then printf '%s:x:10:\n' "$2" >>"$root/etc/group"; fi
  if [ "${1:-}" != -S ]; then printf '%s %s\n' "${MOCK_GROUPS:-users}" "$2" >"$state/$1.groups"; fi
  ;;
cloud-init) : ;;
netplan)
  action=${1:-}; shift || :
  case "$action" in
  generate)
    [ -z "${MOCK_NETPLAN_GENERATE_DELAY:-}" ] || /bin/sleep "$MOCK_NETPLAN_GENERATE_DELAY"
    [ "${MOCK_NETPLAN_GENERATE_FAIL:-0}" = 0 ]
    ;;
  apply|try)
    [ "${MOCK_NETPLAN_APPLY_FAIL:-0}" = 0 ] || exit 1
    if [ "${MOCK_NETPLAN_SKIP_RUNTIME:-0}" = 0 ]; then
      cfg="$root/etc/netplan/99-essential-inet.yaml"
      [ -f "$cfg" ] || cfg="$root/etc/netplan/10-base.yaml"
      iface=$(awk '/^    [a-zA-Z0-9_.:-]+:$/ { n=$1; sub(/:$/, "", n); print n; exit }' "$cfg")
      address=$(awk '/^        - [0-9]+\./ { print $2; exit }' "$cfg")
      gateway=$(awk '$1 == "via:" { print $2; exit }' "$cfg")
      mtu=$(awk '$1 == "mtu:" { print $2; exit }' "$cfg")
      metric=$(awk '$1 == "metric:" || $1 == "route-metric:" { print $2; exit }' "$cfg")
      if [ "$cfg" = "$root/etc/netplan/10-base.yaml" ]; then address="${MOCK_ORIGINAL_ADDRESS:-192.0.2.10/24}"; gateway="${MOCK_ORIGINAL_GATEWAY:-192.0.2.1}"; fi
      [ -n "$address" ] || address="${MOCK_DHCP_ADDRESS:-192.0.2.20/24}"
      [ -n "$gateway" ] || gateway="${MOCK_DHCP_GATEWAY:-192.0.2.1}"
      printf '%s\n' "$address" >"$state/$iface.addresses"
      printf '%s\n' "$gateway" >"$state/$iface.gateway"
      [ -z "$mtu" ] || printf '%s\n' "$mtu" >"$state/$iface.mtu"
      [ -z "$metric" ] || printf '%s\n' "$metric" >"$state/$iface.metric"
    fi
    [ -z "${MOCK_NETPLAN_APPLY_DELAY:-}" ] || /bin/sleep "$MOCK_NETPLAN_APPLY_DELAY"
    ;;
  *) exit 2 ;;
  esac
  ;;
ifquery)
  [ "${MOCK_IFQUERY_FAIL:-0}" = 0 ]
  ;;
ifreload|ifup)
  [ "${MOCK_IF_APPLY_FAIL:-0}" = 0 ] || exit 1
  iface=""; for value in "$@"; do case "$value" in -*) ;; *) iface=$value ;; esac; done
  [ -n "$iface" ] || iface="${MOCK_IFACE:-ens18}"
  cfg="$root/etc/network/interfaces"
  [ -f "$root/etc/network/interfaces.d/99-essential-inet" ] && cfg="$root/etc/network/interfaces.d/99-essential-inet"
  address=$(awk -v target="$iface" '$1 == "iface" && $2 == target { active=1; next } active && $1 == "address" { print $2; exit } active && /^[^[:space:]]/ { exit }' "$cfg")
  [ -n "$address" ] || address="${MOCK_DHCP_ADDRESS:-192.0.2.20/24}"
  printf '%s\n' "$address" >"$state/$iface.addresses"
  gateway=$(awk -v target="$iface" '$1 == "iface" && $2 == target { active=1; next } active && $1 == "gateway" { print $2; exit } active && /^[^[:space:]]/ { exit }' "$cfg")
  metric=$(awk -v target="$iface" '$1 == "iface" && $2 == target { active=1; next } active && $1 == "metric" { print $2; exit } active && /^[^[:space:]]/ { exit }' "$cfg")
  mtu=$(awk -v target="$iface" '$1 == "iface" && $2 == target { active=1; next } active && $1 == "mtu" { print $2; exit } active && /^[^[:space:]]/ { exit }' "$cfg")
  [ -n "$gateway" ] || gateway="${MOCK_DHCP_GATEWAY:-192.0.2.1}"
  printf '%s\n' "$gateway" >"$state/$iface.gateway"
  [ -z "$metric" ] || printf '%s\n' "$metric" >"$state/$iface.metric"
  [ -z "$mtu" ] || printf '%s\n' "$mtu" >"$state/$iface.mtu"
  ;;
ifdown) : ;;
resolvconf) : ;;
nohup) exec "$@" ;;
sleep) /bin/sleep "$@" ;;
date) printf '2026-08-29T00:00:00Z\n' ;;
od) printf '0123456789abcdef0123456789abcdef0123456789abcdef\n' ;;
stat)
  if [ "$1" = -c ]; then /usr/bin/stat "$@"; else exit 2; fi
  ;;
chown) : ;;
kill) /bin/kill "$@" ;;
nmcli)
  printf 'GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:mock\n'
  ;;
ip)
  if [ "${1:-}" = -d ]; then shift; fi
  if [ "${1:-}" = -o ] && [ "${2:-}" = link ] && [ "${3:-}" = show ]; then
    shift 3
    if [ "${1:-}" = dev ]; then
      iface=$2; [ -f "$state/$iface.exists" ] || exit 1
      mtu=$(cat "$state/$iface.mtu" 2>/dev/null || printf 1500)
      status=$(cat "$state/$iface.state" 2>/dev/null || printf UP)
      mac=$(cat "$state/$iface.mac" 2>/dev/null || printf '02:00:00:00:00:01')
      printf '2: %s: <BROADCAST,MULTICAST,UP> mtu %s state %s mode DEFAULT group default qlen 1000 link/ether %s brd ff:ff:ff:ff:ff:ff\n' "$iface" "$mtu" "$status" "$mac"
    else
      for file in "$state"/*.exists; do
        [ -f "$file" ] || continue; iface=${file##*/}; iface=${iface%.exists}
        printf '2: %s: <BROADCAST,MULTICAST,UP> mtu 1500 state UP mode DEFAULT group default qlen 1000 link/ether 02:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff\n' "$iface"
      done
    fi
    exit 0
  fi
  if [ "${1:-}" = -o ] && [ "${2:-}" = -4 ] && [ "${3:-}" = addr ] && [ "${4:-}" = show ]; then
    iface=$6; addresses=$(cat "$state/$iface.addresses" 2>/dev/null || :)
    n=2; for address in $addresses; do printf '%s: %s    inet %s scope global %s\n' "$n" "$iface" "$address" "$iface"; n=$((n+1)); done
    exit 0
  fi
  if [ "${1:-}" = -4 ] && [ "${2:-}" = route ] && [ "${3:-}" = show ] && [ "${4:-}" = default ]; then
    iface=""; [ "${5:-}" = dev ] && iface=$6
    for file in "$state"/*.gateway; do
      [ -f "$file" ] || continue; item=${file##*/}; item=${item%.gateway}; [ -z "$iface" ] || [ "$iface" = "$item" ] || continue
      gateway=$(cat "$file"); [ -n "$gateway" ] || continue; metric=$(cat "$state/$item.metric" 2>/dev/null || :)
      printf 'default via %s dev %s%s\n' "$gateway" "$item" "${metric:+ metric $metric}"
    done
    exit 0
  fi
  if [ "${1:-}" = -4 ] && [ "${2:-}" = route ] && [ "${3:-}" = show ] && [ "${4:-}" = dev ]; then
    iface=$5; gateway=$(cat "$state/$iface.gateway" 2>/dev/null || :); [ -z "$gateway" ] || printf 'default via %s dev %s\n' "$gateway" "$iface"; exit 0
  fi
  exit 2
  ;;
systemctl)
  action=$1; shift
  case "$action" in
  cat)
    unit=${1%.service}; case " ${MOCK_UNITS:-} " in *" $unit "*) exit 0 ;; *) exit 1 ;; esac
    ;;
  is-enabled)
    unit=${1%.service}; file="$state/$unit.enabled"
    [ -f "$file" ] || { printf 'disabled\n'; exit 1; }
    value=$(cat "$file"); printf '%s\n' "$value"; [ "$value" = enabled ]
    ;;
  is-active)
    [ "${1:-}" = --quiet ] && shift
    unit=${1%.service}; [ "$(cat "$state/$unit.active" 2>/dev/null || printf inactive)" = active ]
    ;;
  disable)
    [ "${1:-}" = --now ] && shift
    unit=${1%.service}; [ "${MOCK_FAIL_DISABLE:-}" != "$unit" ] || exit 1
    printf disabled >"$state/$unit.enabled"; printf inactive >"$state/$unit.active"
    ;;
  mask)
    unit=${1%.service}; [ "${MOCK_FAIL_MASK:-}" != "$unit" ] || exit 1
    printf masked >"$state/$unit.enabled"
    ;;
  *) exit 2 ;;
  esac
  ;;
*) printf 'unexpected mock command: %s\n' "$name" >&2; exit 127 ;;
esac
'''


class ToolCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="essential-tests-")
        self.base = Path(self.temp.name)
        self.root = self.base / "root"
        self.bin = self.base / "bin"
        self.state = self.base / "state"
        for directory in (self.root / "etc", self.root / "var", self.bin, self.state):
            directory.mkdir(parents=True, exist_ok=True)
        (self.root / "etc/passwd").write_text(
            "root:x:0:0:root:/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/sh\n"
        )
        (self.root / "etc/group").write_text("users:x:100:\nsudo:x:27:\nwheel:x:10:\n")
        (self.root / "etc/login.defs").write_text("UID_MIN 1000\nUID_MAX 60000\n")
        (self.root / "etc/os-release").write_text("ID=debian\n")
        (self.root / "etc/sudoers").write_text("Defaults env_reset\n@includedir /etc/sudoers.d\n")
        (self.root / "etc/sudoers.d").mkdir()
        self.dispatcher = self.base / "dispatcher"
        self.dispatcher.write_text(DISPATCHER)
        self.dispatcher.chmod(0o755)
        for utility in ("awk", "cat", "chmod", "cp", "grep", "install", "ln", "mkdir", "mktemp", "mv", "rm", "sh", "touch", "tr"):
            source = shutil.which(utility)
            if not source:
                self.fail(f"required test utility is unavailable: {utility}")
            (self.bin / utility).symlink_to(source)
        for command in ("id", "getent", "logname", "groupadd", "usermod", "addgroup", "systemctl", "cloud-init"):
            (self.bin / command).symlink_to(self.dispatcher)
        self.log = self.base / "commands.log"
        self.log.write_text("")
        self.env = {
            "PATH": str(self.bin),
            "ESSENTIAL_TEST_ROOT": str(self.root),
            "MOCK_BIN": str(self.bin),
            "MOCK_DISPATCHER": str(self.dispatcher),
            "MOCK_LOG": str(self.log),
            "MOCK_STATE": str(self.state),
            "MOCK_EUID": "0",
            "MOCK_GROUPS": "users",
            "LC_ALL": "C",
        }

    def tearDown(self):
        token_file = self.root / "run/essential-inet/lock/token"
        if token_file.is_file():
            token = token_file.read_text().strip()
            if len(token) == 48:
                self.run_tool(INET_TOOL, "--confirm", token)
        self.temp.cleanup()

    def mock(self, name):
        path = self.bin / name
        if not path.exists():
            path.symlink_to(self.dispatcher)

    def unmock(self, name):
        path = self.bin / name
        if path.exists() or path.is_symlink():
            path.unlink()

    def run_tool(self, tool, *args, input_text=None, shell="/bin/dash", **env):
        merged = self.env | {key: str(value) for key, value in env.items()}
        return subprocess.run(
            [shell, str(tool), *args],
            text=True,
            input=input_text,
            capture_output=True,
            env=merged,
            timeout=10,
        )

    def install_sudo_mocks(self):
        self.mock("sudo")
        self.mock("visudo")

    def init_cloud(self, units="cloud-init-local cloud-init cloud-config cloud-final", enabled="enabled", active="active"):
        (self.root / "etc/cloud/cloud.cfg.d").mkdir(parents=True)
        for unit in units.split():
            (self.state / f"{unit}.enabled").write_text(enabled)
            (self.state / f"{unit}.active").write_text(active)
        return {"MOCK_UNITS": units}

    def init_net(self, distro="ubuntu", backend="netplan", address="192.0.2.10/24", secondary=""):
        for command in ("ip", "stat", "chown", "date", "od", "nohup", "sleep", "kill"):
            self.mock(command)
        (self.state / "ens18.exists").touch()
        (self.state / "ens18.state").write_text("UP")
        (self.state / "ens18.mac").write_text("02:00:00:00:00:18")
        (self.state / "ens18.mtu").write_text("1500")
        (self.state / "ens18.addresses").write_text("\n".join(filter(None, (address, secondary))) + "\n")
        (self.state / "ens18.gateway").write_text("192.0.2.1")
        (self.root / "etc/os-release").write_text(f"ID={distro}\nVERSION_ID=12\n")
        (self.root / "sys/class/net/ens18").mkdir(parents=True)
        if backend == "netplan":
            self.mock("netplan")
            netplan = self.root / "etc/netplan"
            netplan.mkdir(parents=True)
            (netplan / "10-base.yaml").write_text("network:\n  version: 2\n  ethernets:\n    ens18:\n      dhcp4: true\n")
        elif backend == "ifupdown":
            for command in ("ifquery", "ifreload", "ifup", "ifdown", "resolvconf"):
                self.mock(command)
            network = self.root / "etc/network"
            network.mkdir(parents=True)
            (network / "interfaces").write_text("auto ens18\niface ens18 inet dhcp\n")


class SudoTests(ToolCase):
    def test_runs_under_bash_without_readonly_uid_collision(self):
        self.install_sudo_mocks()
        result = self.run_tool(SUDO_TOOL, "alice", shell="/bin/bash")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Target user: alice", result.stdout)

    def test_argument_precedes_sudo_user_and_logname(self):
        self.install_sudo_mocks()
        result = self.run_tool(SUDO_TOOL, "alice", SUDO_USER="missing", MOCK_LOGNAME="missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Target user: alice", result.stdout)

    def test_sudo_user_then_logname_then_unique_passwd(self):
        self.install_sudo_mocks()
        result = self.run_tool(SUDO_TOOL, SUDO_USER="alice", MOCK_LOGNAME="missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_tool(SUDO_TOOL, MOCK_LOGNAME="alice", MOCK_GROUPS="users sudo")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_tool(SUDO_TOOL, MOCK_GROUPS="users sudo")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_validates_each_source_and_login_defs_range(self):
        self.install_sudo_mocks()
        invalid = self.run_tool(SUDO_TOOL, "bad;name")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("invalid user name", invalid.stderr)
        option_like = self.run_tool(SUDO_TOOL, "--help")
        self.assertNotEqual(option_like.returncode, 0)
        self.assertIn("invalid user name", option_like.stderr)
        outside = self.run_tool(SUDO_TOOL, SUDO_USER="root")
        self.assertEqual(outside.returncode, 0, outside.stderr)  # root is ignored; unique alice is used
        (self.root / "etc/login.defs").write_text("UID_MIN banana\nUID_MAX 60000\n")
        broken = self.run_tool(SUDO_TOOL, "alice")
        self.assertNotEqual(broken.returncode, 0)
        self.assertIn("invalid UID_MIN/UID_MAX", broken.stderr)

    def test_missing_login_defs_uses_documented_defaults(self):
        self.install_sudo_mocks()
        (self.root / "etc/login.defs").unlink()
        result = self.run_tool(SUDO_TOOL, "alice")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_multiple_regular_users_require_explicit_target(self):
        self.install_sudo_mocks()
        with (self.root / "etc/passwd").open("a") as passwd:
            passwd.write("bob:x:1001:1001::/home/bob:/bin/sh\n")
        result = self.run_tool(SUDO_TOOL)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("multiple regular users", result.stderr)

    def test_elevation_uses_file_argv_and_falls_back_from_sudo_to_su(self):
        self.install_sudo_mocks()
        self.mock("su")
        result = self.run_tool(SUDO_TOOL, "alice", MOCK_EUID="1000", MOCK_SUDO_FAIL="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("sudo <-v>", calls)
        self.assertIn(f"su <-s> </bin/sh> <root> <--> <{SUDO_TOOL}> <alice>", calls)
        elevated = "\n".join(line for line in calls.splitlines() if line.startswith(("sudo ", "su ")))
        self.assertNotIn("<-c>", elevated)

    def test_each_package_manager_and_arch_failure_guidance(self):
        for manager in ("apt-get", "dnf", "pacman", "apk"):
            with self.subTest(manager=manager):
                for name in ("apt-get", "dnf", "pacman", "apk", "sudo", "visudo"):
                    self.unmock(name)
                self.mock(manager)
                result = self.run_tool(SUDO_TOOL, "alice")
                self.assertEqual(result.returncode, 0, (manager, result.stderr))
                if manager == "pacman":
                    self.assertIn("pacman <-S> <--needed> <sudo>", self.log.read_text())
        for name in ("apt-get", "dnf", "apk", "sudo", "visudo"):
            self.unmock(name)
        self.mock("pacman")
        failed = self.run_tool(SUDO_TOOL, "alice", MOCK_PACKAGE_FAIL="1")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("pacman -Syu", failed.stderr)

    def test_alpine_uses_addgroup_target_wheel(self):
        self.install_sudo_mocks()
        (self.root / "etc/os-release").write_text("ID=alpine\n")
        result = self.run_tool(SUDO_TOOL, "alice")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("addgroup <alice> <wheel>", self.log.read_text())

    def test_equivalent_policy_is_not_duplicated(self):
        self.install_sudo_mocks()
        policy = self.root / "etc/sudoers.d/existing"
        policy.write_text("%sudo ALL = (ALL) ALL # equivalent\n")
        result = self.run_tool(SUDO_TOOL, "alice")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list((self.root / "etc/sudoers.d").iterdir()), [policy])
        self.assertIn("Sudoers validation: valid (existing)", result.stdout)

    def test_ignored_sudoers_filename_does_not_suppress_active_policy(self):
        self.install_sudo_mocks()
        ignored = self.root / "etc/sudoers.d/ignored.policy"
        ignored.write_text("%sudo ALL=(ALL:ALL) ALL\n")
        result = self.run_tool(SUDO_TOOL, "alice")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "etc/sudoers.d/90-essential-admin").exists())

    def test_candidate_install_mode_and_final_validation_rollback(self):
        self.install_sudo_mocks()
        result = self.run_tool(SUDO_TOOL, "alice")
        policy = self.root / "etc/sudoers.d/90-essential-admin"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(policy.stat().st_mode), 0o440)
        self.assertIn("visudo <-cf>", self.log.read_text())
        policy.unlink()
        failed = self.run_tool(SUDO_TOOL, "alice", MOCK_VISUDO_FAIL_FINAL="1")
        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse(policy.exists())
        self.assertIn("rolled back", failed.stderr)

    def test_invalid_candidate_is_never_installed(self):
        self.install_sudo_mocks()
        result = self.run_tool(SUDO_TOOL, "alice", MOCK_VISUDO_FAIL_CANDIDATE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "etc/sudoers.d/90-essential-admin").exists())
        self.assertIn("candidate sudoers policy failed", result.stderr)
        self.assertFalse((self.state / "alice.groups").exists())

    def test_missing_sudoers_include_refuses_before_group_change(self):
        self.install_sudo_mocks()
        (self.root / "etc/sudoers").write_text("Defaults env_reset\n")
        result = self.run_tool(SUDO_TOOL, "alice")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not include /etc/sudoers.d", result.stderr)
        self.assertFalse((self.state / "alice.groups").exists())


class CinitTests(ToolCase):
    def test_help_and_unknown_option_need_no_root_or_host_access(self):
        help_result = self.run_tool(CINIT_TOOL, "--help", MOCK_EUID="1000")
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("--dry-run", help_result.stdout)
        bad = self.run_tool(CINIT_TOOL, "--bogus")
        self.assertNotEqual(bad.returncode, 0)

    def test_missing_cloud_directory_is_noop(self):
        result = self.run_tool(CINIT_TOOL, "--yes")
        self.assertEqual(result.returncode, 0)
        self.assertIn("nothing changed", result.stdout)
        self.assertFalse((self.root / "var/backups").exists())

    def test_prechecks_cloud_init_and_detected_units(self):
        env = self.init_cloud(units="")
        no_units = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertNotEqual(no_units.returncode, 0)
        self.assertIn("no cloud-init systemd units", no_units.stderr)
        self.unmock("cloud-init")
        missing_binary = self.run_tool(CINIT_TOOL, "--yes", MOCK_UNITS="cloud-init")
        self.assertNotEqual(missing_binary.returncode, 0)
        self.assertIn("cloud-init executable is missing", missing_binary.stderr)

    def test_confirmation_rejection_changes_nothing(self):
        env = self.init_cloud(units="cloud-init")
        result = self.run_tool(CINIT_TOOL, input_text="no\n", **env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cancelled", result.stderr)
        self.assertFalse((self.root / "etc/cloud/cloud-init.disabled").exists())
        self.assertFalse((self.root / "var/backups").exists())

    def test_dry_run_reports_without_files_units_or_backup_changes(self):
        env = self.init_cloud(units="cloud-init")
        before = self.log.read_text()
        result = self.run_tool(CINIT_TOOL, "--dry-run", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("changes are required", result.stdout)
        self.assertFalse((self.root / "etc/cloud/cloud-init.disabled").exists())
        self.assertFalse((self.root / "var/backups").exists())
        calls = self.log.read_text()[len(before):]
        self.assertNotIn("systemctl <disable>", calls)
        self.assertNotIn("systemctl <mask>", calls)

    def test_safe_elevation_falls_back_to_su_without_command_payload(self):
        env = self.init_cloud(units="cloud-init", enabled="masked", active="inactive")
        (self.root / "etc/cloud/cloud-init.disabled").touch()
        (self.root / "etc/cloud/cloud.cfg.d/99-disable-network-config.cfg").write_text("network: {config: disabled}\n")
        self.mock("sudo")
        self.mock("su")
        result = self.run_tool(CINIT_TOOL, "--yes", MOCK_EUID="1000", MOCK_SUDO_FAIL="1", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("sudo <-v>", calls)
        self.assertIn(f"su <-s> </bin/sh> <root> <--> <{CINIT_TOOL}> <--yes>", calls)
        elevated = "\n".join(line for line in calls.splitlines() if line.startswith(("sudo ", "su ")))
        self.assertNotIn("<-c>", elevated)

    def test_success_backup_verification_and_unique_second_backup(self):
        env = self.init_cloud(units="cloud-init cloud-final")
        network = self.root / "etc/cloud/cloud.cfg.d/99-disable-network-config.cfg"
        network.write_text("network: {config: dhcp}\n")
        first = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("Verified:", first.stdout)
        self.assertEqual(network.read_text(), "network: {config: disabled}\n")
        backups = list((self.root / "var/backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "99-disable-network-config.cfg").read_text(), "network: {config: dhcp}\n")
        network.write_text("network: {config: fallback}\n")
        second = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(list((self.root / "var/backups").iterdir())), 2)

    def test_idempotent_run_does_not_create_another_backup(self):
        env = self.init_cloud(units="cloud-init", enabled="masked", active="inactive")
        (self.root / "etc/cloud/cloud-init.disabled").touch()
        (self.root / "etc/cloud/cloud.cfg.d/99-disable-network-config.cfg").write_text("network: {config: disabled}\n")
        result = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already disabled", result.stdout)
        self.assertFalse((self.root / "var/backups").exists())

    def test_conflicting_network_policy_is_replaced_and_backed_up(self):
        env = self.init_cloud(units="cloud-init", enabled="masked", active="inactive")
        (self.root / "etc/cloud/cloud-init.disabled").touch()
        network = self.root / "etc/cloud/cloud.cfg.d/99-disable-network-config.cfg"
        original = "network: {config: disabled}\nnetwork: {config: dhcp}\n"
        network.write_text(original)
        result = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(network.read_text(), "network: {config: disabled}\n")
        backup = next((self.root / "var/backups").iterdir())
        self.assertEqual((backup / "99-disable-network-config.cfg").read_text(), original)

    def test_backup_records_nonzero_systemd_state_verbatim(self):
        env = self.init_cloud(units="cloud-init", enabled="static", active="inactive")
        result = self.run_tool(CINIT_TOOL, "--yes", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        backup = next((self.root / "var/backups").iterdir())
        self.assertEqual((backup / "unit-states").read_text(), "cloud-init static inactive\n")

    def test_per_unit_failure_is_recorded_and_never_reports_success(self):
        env = self.init_cloud(units="cloud-init cloud-final")
        failed = self.run_tool(CINIT_TOOL, "--yes", MOCK_FAIL_MASK="cloud-final", **env)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("cloud-final-mask", failed.stderr)
        self.assertIn("cloud-final-mask-verification", failed.stderr)
        self.assertIn("rollback:", failed.stderr)
        self.assertNotIn("Verified:", failed.stdout)


class InetTests(ToolCase):
    STATIC = (
        "--interface", "ens18", "--mode", "static",
        "--address", "192.0.2.50/24", "--gateway", "192.0.2.1",
        "--dns", "1.1.1.1,8.8.8.8", "--metric", "100", "--mtu", "1500",
    )

    def test_help_and_show_need_no_root(self):
        help_result = self.run_tool(INET_TOOL, "--help", MOCK_EUID="1000")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("--rollback", help_result.stdout)
        self.init_net()
        shown = self.run_tool(INET_TOOL, "--show", MOCK_EUID="1000")
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertIn("ens18", shown.stdout)
        self.assertIn("netplan", shown.stdout)
        self.assertIn("yes", shown.stdout)

    def test_detects_ubuntu_netplan_and_static_dry_run_without_writes(self):
        self.init_net()
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        result = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Backend: netplan", result.stdout)
        self.assertIn("routes:", result.stdout)
        self.assertIn("metric: 100", result.stdout)
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(after, before)
        self.assertFalse((self.root / "var/backups").exists())
        self.assertNotIn("netplan <apply>", self.log.read_text())

    def test_detects_debian_ifupdown_and_dhcp_dry_run(self):
        self.init_net(distro="debian", backend="ifupdown")
        result = self.run_tool(INET_TOOL, "--dry-run", "--interface", "ens18", "--mode", "dhcp", "--mtu", "1400")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Backend: ifupdown", result.stdout)
        self.assertIn("iface ens18 inet dhcp", result.stdout)
        self.assertIn("mtu 1400", result.stdout)

        metric = self.run_tool(INET_TOOL, "--dry-run", "--interface", "ens18", "--mode", "dhcp", "--metric", "42")
        self.assertEqual(metric.returncode, 0, metric.stderr)
        self.assertIn("metric 42", metric.stdout)

        (self.root / "etc/network/interfaces").write_text(
            "auto ens18\niface ens18 inet static\n    address 192.0.2.10/24\n    gateway 192.0.2.1\n"
        )
        applied = self.run_tool(INET_TOOL, "--interface", "ens18", "--mode", "dhcp", "--yes", SSH_CONNECTION="client")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual((self.state / "ens18.addresses").read_text().strip(), "192.0.2.20/24")

    def test_rejects_ambiguous_and_networkmanager_backends(self):
        self.init_net()
        network = self.root / "etc/network"
        network.mkdir(parents=True)
        (network / "interfaces").write_text("auto ens18\niface ens18 inet dhcp\n")
        ambiguous = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertNotEqual(ambiguous.returncode, 0)
        self.assertIn("ambiguous", ambiguous.stderr)
        (network / "interfaces").unlink()
        self.mock("nmcli")
        nm = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertNotEqual(nm.returncode, 0)
        self.assertIn("NetworkManager", nm.stderr)

    def test_validation_rejects_bad_values_and_gateway_outside_subnet(self):
        self.init_net()
        cases = [
            (("--address", "999.1.1.1/24"), "invalid IPv4/CIDR"),
            (("--address", "192.0.2.50/33"), "invalid IPv4/CIDR"),
            (("--gateway", "192.0.3.1"), "outside"),
            (("--dns", "1.1.1.999"), "invalid DNS"),
            (("--metric", "-1"), "metric"),
            (("--mtu", "500"), "MTU"),
            (("--mtu", "999999999999999999999999"), "MTU"),
            (("--metric", "999999999999999999999999"), "metric"),
            (("--interface", "bad/name"), "invalid interface"),
        ]
        for replacement, message in cases:
            args = list(self.STATIC)
            option, value = replacement
            index = args.index(option)
            args[index + 1] = value
            with self.subTest(option=option, value=value):
                result = self.run_tool(INET_TOOL, "--dry-run", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_secondary_ipv4_is_preserved_and_other_interface_untouched(self):
        self.init_net(secondary="192.0.2.11/24")
        source = self.root / "etc/netplan/10-base.yaml"
        source.write_text("network:\n  version: 2\n  ethernets:\n    ens18:\n      dhcp4: true\n      dhcp6: true\n    ens19:\n      dhcp4: true\n")
        result = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("192.0.2.11/24", result.stdout)
        self.assertEqual(source.read_text(), "network:\n  version: 2\n  ethernets:\n    ens18:\n      dhcp4: true\n      dhcp6: true\n    ens19:\n      dhcp4: true\n")

        managed = self.root / "etc/netplan/99-essential-inet.yaml"
        managed.write_text("network:\n  version: 2\n  ethernets:\n    ens19:\n      dhcp4: true\n")
        refused = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("manages another interface", refused.stderr)

    def test_static_apply_creates_backup_absent_marker_and_atomic_file(self):
        self.init_net()
        result = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client")
        self.assertEqual(result.returncode, 0, result.stderr)
        managed = self.root / "etc/netplan/99-essential-inet.yaml"
        self.assertTrue(managed.exists())
        self.assertEqual(stat.S_IMODE(managed.stat().st_mode), 0o600)
        self.assertFalse(list(managed.parent.glob(".essential-inet.*")))
        backup = next((self.root / "var/backups").iterdir())
        self.assertTrue((backup / "config.absent").exists())
        self.assertTrue((backup / "rollback").exists())
        self.assertIn("essential-inet-backup: 1", (backup / "manifest").read_text())
        self.assertIn("Confirm with:", result.stdout)
        token = (self.root / "run/essential-inet/lock/token").read_text().strip()
        self.assertEqual(len(token), 48)

    def test_existing_managed_file_is_backed_up_and_idempotent_run_skips_backup(self):
        self.init_net()
        managed = self.root / "etc/netplan/99-essential-inet.yaml"
        original = "network:\n  version: 2\n  ethernets:\n    ens18:\n      dhcp4: true\n      addresses: []\n"
        managed.write_text(original)
        managed.chmod(0o640)
        first = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client")
        self.assertEqual(first.returncode, 0, first.stderr)
        backup = next((self.root / "var/backups").iterdir())
        self.assertEqual((backup / "old-config").read_text(), original)
        token = (self.root / "run/essential-inet/lock/token").read_text().strip()
        confirm = self.run_tool(INET_TOOL, "--confirm", token)
        self.assertEqual(confirm.returncode, 0, confirm.stderr)
        count = len(list((self.root / "var/backups").iterdir()))
        second = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("already present", second.stdout)
        self.assertEqual(len(list((self.root / "var/backups").iterdir())), count)

    def test_candidate_failure_rolls_back_before_apply(self):
        self.init_net()
        failed = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client", MOCK_NETPLAN_GENERATE_FAIL="1")
        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse((self.root / "etc/netplan/99-essential-inet.yaml").exists())
        self.assertIn("candidate validation failed", failed.stderr)

    def test_apply_and_verification_failures_roll_back(self):
        for env in ({"MOCK_NETPLAN_APPLY_FAIL": "1"}, {"MOCK_NETPLAN_SKIP_RUNTIME": "1"}):
            with self.subTest(env=env):
                self.tearDown()
                self.setUp()
                self.init_net()
                failed = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client", **env)
                self.assertNotEqual(failed.returncode, 0)
                self.assertFalse((self.root / "etc/netplan/99-essential-inet.yaml").exists())
                self.assertIn("roll", failed.stderr.lower())

    def test_confirmation_token_and_invalid_token(self):
        self.init_net()
        result = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client")
        self.assertEqual(result.returncode, 0, result.stderr)
        token = (self.root / "run/essential-inet/lock/token").read_text().strip()
        invalid = self.run_tool(INET_TOOL, "--confirm", "../bad")
        self.assertNotEqual(invalid.returncode, 0)
        confirmed = self.run_tool(INET_TOOL, "--confirm", token)
        self.assertEqual(confirmed.returncode, 0, confirmed.stderr)
        self.assertFalse((self.root / "run/essential-inet/lock").exists())

    def test_watchdog_timeout_rolls_back_and_transaction_lock_refuses_second_change(self):
        self.init_net()
        first = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client", ESSENTIAL_INET_TIMEOUT="30")
        self.assertEqual(first.returncode, 0, first.stderr)
        locked = self.run_tool(INET_TOOL, "--interface", "ens18", "--mode", "dhcp", "--yes", SSH_CONNECTION="client")
        self.assertNotEqual(locked.returncode, 0)
        self.assertIn("transaction", locked.stderr)
        token = (self.root / "run/essential-inet/lock/token").read_text().strip()
        watchdog = self.run_tool(INET_TOOL, "--watchdog", token, ESSENTIAL_INET_WATCHDOG_TIMEOUT="0")
        self.assertEqual(watchdog.returncode, 0, watchdog.stderr)
        self.assertFalse((self.root / "etc/netplan/99-essential-inet.yaml").exists())

    def test_ifupdown_replaces_only_one_ipv4_stanza(self):
        self.init_net(distro="debian", backend="ifupdown")
        interfaces = self.root / "etc/network/interfaces"
        interfaces.write_text(
            "auto ens18\niface ens18 inet dhcp\n\n"
            "iface ens18 inet6 static\n    address 2001:db8::2/64\n\n"
            "auto ens19\niface ens19 inet dhcp\n"
        )
        result = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client")
        self.assertEqual(result.returncode, 0, result.stderr)
        text = interfaces.read_text()
        self.assertEqual(text.count("iface ens18 inet static"), 1)
        self.assertNotIn("iface ens18 inet dhcp", text)
        self.assertIn("iface ens18 inet6 static", text)
        self.assertIn("iface ens19 inet dhcp", text)

    def test_ifupdown_duplicate_stanza_is_rejected_and_top_level_comment_is_preserved(self):
        self.init_net(distro="debian", backend="ifupdown")
        interfaces = self.root / "etc/network/interfaces"
        interfaces.write_text("auto ens18\niface ens18 inet dhcp\n# ens19 follows\nauto ens19\niface ens19 inet dhcp\n")
        changed = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn("# ens19 follows", changed.stdout)
        interfaces.write_text("auto ens18\niface ens18 inet dhcp\nhostname stale\nup /usr/local/bin/stale\nallow-foo ens19\niface ens19 inet dhcp\n")
        unindented = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertEqual(unindented.returncode, 0, unindented.stderr)
        self.assertNotIn("hostname stale", unindented.stdout)
        self.assertNotIn("/usr/local/bin/stale", unindented.stdout)
        self.assertIn("allow-foo ens19", unindented.stdout)
        interfaces.write_text("auto ens18\niface ens18 inet dhcp\niface ens18 inet static\n    address 192.0.2.9/24\n")
        duplicate = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("duplicate IPv4 stanzas", duplicate.stderr)

        nested = self.root / "etc/network/interfaces.d/base"
        nested.parent.mkdir(exist_ok=True)
        interfaces.write_text("source-directory /etc/network/interfaces.d\n")
        nested.write_text("source /etc/network/more/*\n")
        nested_result = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC)
        self.assertNotEqual(nested_result.returncode, 0)
        self.assertIn("nested interfaces includes", nested_result.stderr)

    def test_invalid_watchdog_timeout_does_not_mutate(self):
        self.init_net()
        failed = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client", ESSENTIAL_INET_TIMEOUT="0")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("invalid rollback timeout", failed.stderr)
        self.assertFalse((self.root / "etc/netplan/99-essential-inet.yaml").exists())
        self.assertFalse((self.root / "var/backups").exists())

    def test_safe_elevation_and_signal_temp_cleanup(self):
        self.init_net()
        self.mock("sudo")
        self.mock("su")
        result = self.run_tool(INET_TOOL, "--dry-run", *self.STATIC, MOCK_EUID="1000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("sudo <-v>", self.log.read_text())
        applied = self.run_tool(INET_TOOL, *self.STATIC, "--yes", SSH_CONNECTION="client", MOCK_EUID="1000", MOCK_SUDO_FAIL="1")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        calls = self.log.read_text()
        self.assertIn("sudo <-v>", calls)
        self.assertIn(f"su <-s> </bin/sh> <root> <--> <{INET_TOOL}>", calls)
        self.assertNotIn("<-c>", calls)

    def test_signal_cleans_candidate_and_rolls_back(self):
        self.init_net()
        merged = self.env | {
            "SSH_CONNECTION": "client",
            "MOCK_NETPLAN_GENERATE_DELAY": "1",
        }
        process = subprocess.Popen(
            ["/bin/dash", str(INET_TOOL), *self.STATIC, "--yes"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=merged,
            start_new_session=True,
        )
        managed = self.root / "etc/netplan/99-essential-inet.yaml"
        for _ in range(100):
            if managed.exists():
                break
            import time
            time.sleep(0.02)
        self.assertTrue(managed.exists())
        os.killpg(process.pid, 15)
        stdout, stderr = process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0, stdout + stderr)
        self.assertFalse(managed.exists())
        self.assertFalse(list((self.root / "etc/netplan").glob(".essential-inet.*")))


class StaticSafetyTests(unittest.TestCase):
    def test_scripts_are_executable_posix_and_have_no_payload_or_sh_c(self):
        for tool in (SUDO_TOOL, CINIT_TOOL, INET_TOOL):
            text = tool.read_text()
            self.assertTrue(text.startswith("#!/usr/bin/env sh\n# essential tool:"))
            self.assertIn("\n# source: https://github.com/x-inu/essential/tree/main/tools\n", text)
            self.assertIn("set -eu", text)
            self.assertNotIn("PAYLOAD=", text)
            self.assertNotIn("sh -c", text)
            self.assertEqual(stat.S_IMODE(tool.stat().st_mode), 0o755)


if __name__ == "__main__":
    unittest.main(verbosity=2)
