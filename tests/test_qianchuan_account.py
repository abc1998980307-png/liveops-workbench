import stat
import tempfile
import unittest
from pathlib import Path

from qianchuan_account import QianchuanAccountStore


class QianchuanAccountStoreTests(unittest.TestCase):
    def test_local_account_survives_reopen_without_exposing_id(self):
        with tempfile.TemporaryDirectory() as directory:
            account_id = "7" * 12
            store = QianchuanAccountStore(directory)
            result = store.save({"name": "演示户", "accountId": account_id})
            self.assertEqual(result, {"configured": True, "name": "演示户", "maskedId": "********7777"})
            self.assertNotIn(account_id, str(result))
            self.assertEqual(stat.S_IMODE(store.path.stat().st_mode), 0o600)
            reopened = QianchuanAccountStore(directory)
            self.assertEqual(reopened.state(), result)
            self.assertEqual(reopened.current_id(), account_id)
            self.assertEqual(reopened.save({"name": "新户名", "accountId": ""})["maskedId"], result["maskedId"])
            self.assertEqual(reopened.clear()["configured"], False)
            self.assertFalse(Path(directory, "qianchuan-current-account.json").exists())
            with self.assertRaisesRegex(ValueError, "填写并保存户 ID"):
                reopened.current_id()

    def test_rejects_invalid_values(self):
        with tempfile.TemporaryDirectory() as directory:
            store = QianchuanAccountStore(directory)
            for value in ({"name": "", "accountId": ""}, {"name": "x", "accountId": "not numeric"},
                          {"name": "x\n", "accountId": ""}):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    store.save(value)
            self.assertFalse(store.path.exists())
            store.save({"name": "仅名称", "accountId": ""})
            with self.assertRaisesRegex(ValueError, "填写并保存户 ID"):
                store.current_id()


if __name__ == "__main__":
    unittest.main()
