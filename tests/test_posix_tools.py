#!/usr/bin/env python3
"""Mock-based tests: the tools only see temporary etc/var trees and fake admin commands."""

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


class StaticSafetyTests(unittest.TestCase):
    def test_scripts_are_executable_posix_and_have_no_payload_or_sh_c(self):
        for tool in (SUDO_TOOL, CINIT_TOOL):
            text = tool.read_text()
            self.assertTrue(text.startswith("#!/usr/bin/env sh\n# essential tool:"))
            self.assertIn("\n# source: https://github.com/x-inu/essential/tree/main/tools\n", text)
            self.assertIn("set -eu", text)
            self.assertNotIn("PAYLOAD=", text)
            self.assertNotIn("sh -c", text)
            self.assertEqual(stat.S_IMODE(tool.stat().st_mode), 0o755)


if __name__ == "__main__":
    unittest.main(verbosity=2)
