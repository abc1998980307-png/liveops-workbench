import base64
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qianchuan_credentials import (CredentialStoreError, NativeCredentialBackend,
                                   QianchuanCredentialStore)


class MemoryVault:
    def __init__(self):
        self.secret = None

    def read(self):
        return self.secret

    def write(self, secret):
        self.secret = secret

    def delete(self):
        self.secret = None


class QianchuanCredentialTests(unittest.TestCase):
    def test_only_masked_status_leaves_the_vault(self):
        vault = MemoryVault()
        store = QianchuanCredentialStore(vault)
        self.assertEqual(store.state(), {"saved": False, "maskedAccount": "", "hasPassword": False})
        account, password = "synthetic@example.test", "synthetic-password"
        result = store.save({"account": account, "password": password})
        self.assertEqual(result, {"saved": True, "maskedAccount": "********************st", "hasPassword": True})
        self.assertNotIn(account, json.dumps(result))
        self.assertNotIn(password, json.dumps(result))
        self.assertEqual(json.loads(base64.b64decode(vault.secret)), {"account": account, "password": password})
        self.assertEqual(store.state(), result)
        self.assertEqual(store.clear(), {"saved": False, "maskedAccount": "", "hasPassword": False})
        self.assertIsNone(vault.secret)

    def test_invalid_payload_never_reaches_vault(self):
        vault = MemoryVault()
        store = QianchuanCredentialStore(vault)
        for payload in ({}, {"account": ""}, {"account": "x", "extra": "y"},
                        {"account": 123}, {"account": "a\n", "password": "x"}):
            with self.assertRaises(ValueError):
                store.save(payload)
        self.assertIsNone(vault.secret)

    def test_macos_security_receives_secret_on_stdin_only(self):
        backend = NativeCredentialBackend()
        secret = "synthetic-encoded-secret"
        with mock.patch("qianchuan_credentials.sys.platform", "darwin"), \
             mock.patch("qianchuan_credentials.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, b"")
            backend.write(secret)
            args = run.call_args.args[0]
            self.assertNotIn(secret, args)
            self.assertEqual(run.call_args.kwargs["input"], (secret + "\n").encode())
            run.return_value = subprocess.CompletedProcess([], 0, (secret + "\n").encode())
            self.assertEqual(backend.read(), secret)
            run.return_value = subprocess.CompletedProcess([], 44, b"")
            self.assertIsNone(backend.read())
            backend.delete()

    def test_unavailable_or_corrupt_vault_fails_closed(self):
        vault = MemoryVault()
        store = QianchuanCredentialStore(vault)
        vault.secret = "not-base64"
        with self.assertRaises(CredentialStoreError):
            store.state()


if __name__ == "__main__":
    unittest.main()
