import unittest
from hourly_fact_mcp import dispatch, run_sync


class Result:
    returncode = 0
    stdout = '{"delivered":1,"pending":2,"deferred":1}'
    stderr = 'private upstream detail'


class HourlyFactMCPTest(unittest.TestCase):
    def test_manual_tool_calls_only_with_explicit_valid_window(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return Result()

        since = "2026-11-17T00:00:00.000Z"
        self.assertEqual(run_sync({"execute": True, "since": since}, runner=runner, node="node"),
                         {"delivered": 1, "pending": 2, "deferred": 1})
        self.assertEqual(calls[0][0][-3:], ["--execute=true", "--since=" + since, "--limit=1"])
        self.assertFalse(run_sync({"execute": False, "since": since}, runner=runner, node="node").get("delivered"))
        self.assertEqual(len(calls), 1)

    def test_dispatch_exposes_separate_write_tool_and_redacts_failure(self):
        listed = dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual([tool["name"] for tool in listed["result"]["tools"]], ["sync_hourly_fact"])
        self.assertFalse(listed["result"]["tools"][0]["annotations"]["readOnlyHint"])
        called = dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "sync_hourly_fact", "arguments": {"execute": True,
                "since": "2026-11-17T00:00:00.000Z"}}},
            sync=lambda _: {"error": {"code": "SYNC_FAILED", "message": "交付失败"}})
        self.assertTrue(called["result"]["isError"])
        self.assertNotIn("private", str(called))


if __name__ == "__main__":
    unittest.main()
