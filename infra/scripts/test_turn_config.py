"""Offline TURN config regression checks; no env secrets or containers are used."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/scripts/turn-start.sh"


class TurnConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(
            prefix="turn-check-", dir="/tmp/kilo"
        )
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.secret = self.path / "shared-secret"
        self.secret.write_text("a" * 64 + "\n")
        self.secret.chmod(0o600)
        self.env = {
            "PATH": f"{self.path}:{os.environ['PATH']}",
            "TURN_DOMAIN": "turn.example.com",
            "TURN_PUBLIC_IP": "203.0.113.10",
            "TURN_SHARED_SECRET_PATH": str(self.secret),
            "TURN_RUNTIME_DIR": str(self.path),
            "LIVEKIT_BASE_CONFIG": str(ROOT / "infra/livekit.server.yaml"),
            "COTURN_BASE_CONFIG": str(ROOT / "infra/coturn.conf"),
        }

    def generate(self, mode):
        return subprocess.run(
            ["sh", str(SCRIPT), mode, "--check"],
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_livekit_preserves_base_and_advertises_external_tls_port(self):
        result = self.generate("livekit")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        generated = yaml.safe_load((self.path / "livekit-turn.yaml").read_text())
        servers = generated["rtc"].pop("turn_servers")
        self.assertEqual(
            servers,
            [
                {
                    "host": "turn.example.com",
                    "port": 5349,
                    "protocol": "tls",
                    "secret_file": str(self.secret),
                    "ttl": 14400,
                }
            ],
        )
        self.assertEqual(
            generated, yaml.safe_load(Path(self.env["LIVEKIT_BASE_CONFIG"]).read_text())
        )
        self.assertIs(generated["turn"]["enabled"], False)
        self.assertIn("--turn.enabled=false", SCRIPT.read_text())
        self.assertNotIn("a" * 64, (self.path / "livekit-turn.yaml").read_text())
        # v1.13.1's external TURN branch formats host/port, not embedded :443.
        server = servers[0]
        self.assertEqual(
            f"turns:{server['host']}:{server['port']}?transport=tcp",
            "turns:turn.example.com:5349?transport=tcp",
        )

    def test_coturn_authentication_relay_and_private_config(self):
        result = self.generate("coturn")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("a" * 64, result.stderr)
        config = self.path / "coturn.conf"
        lines = config.read_text().splitlines()
        for line in (
            "use-auth-secret",
            "static-auth-secret=" + "a" * 64,
            "tls-listening-port=5349",
            "min-port=49160",
            "max-port=49200",
            "no-tcp",
            "no-udp",
            "dtls=false",
            "no-tcp-relay",
            "cli=false",
            "listening-ip=203.0.113.10",
            "relay-ip=203.0.113.10",
            "denied-peer-ip=0.0.0.0-255.255.255.255",
            "allowed-peer-ip=203.0.113.10",
        ):
            self.assertIn(line, lines)
        self.assertNotIn("no-auth", lines)
        self.assertNotIn("allow-loopback-peers", lines)
        self.assertFalse(any(line.startswith("external-ip=") for line in lines))
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_rejects_missing_or_world_readable_secret(self):
        self.secret.chmod(0o644)
        self.assertNotEqual(self.generate("livekit").returncode, 0)
        self.assertNotEqual(self.generate("coturn").returncode, 0)
        self.secret.unlink()
        self.assertNotEqual(self.generate("livekit").returncode, 0)

    def test_rejects_empty_short_or_config_injection_secret(self):
        for value in ("", "abc", "a" * 64 + "\nno-auth"):
            with self.subTest(value_length=len(value)):
                self.secret.write_text(value)
                result = self.generate("coturn")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(value or "unused", result.stderr)

    def test_rejects_invalid_domain_and_address(self):
        for domain in ("", "https://turn.example.com", "turn.example.com\nno-auth"):
            self.env["TURN_DOMAIN"] = domain
            self.assertNotEqual(self.generate("livekit").returncode, 0)
        self.env["TURN_DOMAIN"] = "turn.example.com"
        for address in (
            "",
            "256.1.1.1",
            "203.0.113.10\nno-auth",
            "203.0.113.10\n203.0.113.11",
        ):
            self.env["TURN_PUBLIC_IP"] = address
            self.assertNotEqual(self.generate("coturn").returncode, 0)

    def test_codec_defaults(self):
        for name in ("livekit.server.yaml", "livekit.integrated.yaml", "livekit.yaml"):
            config = yaml.safe_load((ROOT / "infra" / name).read_text())
            self.assertEqual(
                config["room"]["enabled_codecs"],
                [
                    {"mime": "audio/opus"},
                    {"mime": "video/vp8"},
                    {"mime": "video/h264"},
                ],
            )

    def test_compose_opt_in_isolation_and_ports(self):
        env = {
            "PATH": os.environ["PATH"],
            "LIVEKIT_API_KEY": "serverkey",
            "LIVEKIT_API_SECRET": "dummy-validation-secret-not-for-deployment",
            "TURN_DOMAIN": "turn.example.com",
            "TURN_PUBLIC_IP": "203.0.113.10",
            "TURN_SECRET_FILE": str(self.secret),
            "TURN_CERT_FILE": str(self.path / "dummy-fullchain.pem"),
            "TURN_KEY_FILE": str(self.path / "dummy-privkey.pem"),
        }
        command = [
            "docker",
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "compose.server.yaml",
        ]

        def render(extra):
            return json.loads(
                subprocess.check_output(
                    command
                    + extra
                    + ["config", "--no-env-resolution", "--format", "json"],
                    cwd=ROOT,
                    env=env,
                    text=True,
                )
            )

        base = render([])["services"]
        enabled = render(["-f", "compose.server.turn.yaml"])["services"]
        self.assertEqual(set(enabled), set(base) | {"coturn"})
        for service in base:
            if service != "livekit":
                self.assertEqual(base[service], enabled[service])
        self.assertEqual(base["livekit"]["ports"], enabled["livekit"]["ports"])
        self.assertEqual(enabled["livekit"]["tmpfs"], ["/tmp:size=16m,mode=0700"])
        self.assertEqual(
            base["livekit"]["environment"]["LIVEKIT_KEYS"],
            enabled["livekit"]["environment"]["LIVEKIT_KEYS"],
        )
        self.assertEqual(
            enabled["livekit"]["environment"]["LIVEKIT_TURN_ENABLED"], "false"
        )
        self.assertEqual(enabled["coturn"].get("network_mode"), "host")
        self.assertFalse(enabled["coturn"].get("ports"))
        self.assertFalse(enabled["coturn"].get("networks"))
        self.assertNotIn("network_mode", enabled["livekit"])
        for service in ("livekit", "coturn"):
            self.assertNotIn("a" * 64, json.dumps(enabled[service]))
            mounts = enabled[service]["volumes"]
            secret_mount = next(
                v for v in mounts if v["target"] == "/run/secrets/turn_shared_secret"
            )
            self.assertTrue(secret_mount["read_only"])
            self.assertIs(secret_mount["bind"]["create_host_path"], False)
        for mount in enabled["coturn"]["volumes"]:
            if mount["target"].startswith("/etc/coturn/tls/"):
                self.assertTrue(mount["read_only"])
                self.assertIs(mount["bind"]["create_host_path"], False)


if __name__ == "__main__":
    unittest.main()
