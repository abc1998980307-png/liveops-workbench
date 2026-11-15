"""Synthetic coverage for local mappings and saved-session aggregation."""

import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from operations_workspace import OperationsWorkspace, WorkspaceError
from team_overview import build_team_overview


class TeamOverviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = OperationsWorkspace(self.temp.name)
        self.member = self.workspace.save("teamMembers", {"name": "合成成员", "role": "主播", "active": True})
        self.store = self.workspace.save("stores", {"name": "合成店铺", "platform": "douyin", "active": True})
        self.mapping = self.workspace.save("accountMappings", {
            "name": "合成直播号", "sourceAlias": "本机来源别名", "memberId": self.member["id"],
            "storeId": self.store["id"], "qianchuanAlias": "投放别名", "active": True})

    def row(self, room, watch=None, sales=None, spend=None, status="匹配", refund_count=None, refund_amount=None):
        metrics = {}
        if watch is not None:
            metrics["entryVisits"] = {"value": watch, "rawUnit": "number"}
        if sales is not None:
            metrics["validSales"] = {"value": sales, "rawUnit": "price"}
        if refund_count is not None:
            metrics["refundCount"] = {"value": refund_count, "rawUnit": "number"}
        if refund_amount is not None:
            metrics["refundAmount"] = {"value": refund_amount, "rawUnit": "price"}
        latest = None
        if spend is not None:
            latest = {"spendReconciliation": {"status": status,
                      "compass": {"roomId": room, "amount": spend},
                      "qianchuan": {"roomId": room, "amount": spend}}}
        return {"accountName": "本机来源别名", "room": {"id": room}, "metrics": metrics, "latest": latest}

    def test_group_totals_coverage_and_todos(self):
        business = {"rows": [self.row("one", 40, 12345, "10.50"),
                              self.row("two", sales=2000, spend="5.00", status="不匹配")],
                    "total": 2, "hasMore": False, "startDate": "2026-11-01", "endDate": "2026-11-15"}
        review = {"sessionId": "a" * 32, "owner": "合成成员", "actions": "检查合成脚本",
                  "dueDate": "2026-11-20", "updatedAt": "2026-11-15T00:00:00Z"}
        result = build_team_overview(self.workspace.snapshot(), business, [review])
        account = result["groups"]["accounts"][0]
        self.assertEqual(account["sessions"], 2)
        self.assertEqual(account["watch"], {"value": 40, "coveredRooms": 1})
        self.assertEqual(account["sales"], {"value": 143.45, "coveredRooms": 2})
        self.assertEqual(account["spend"], {"value": "15.50", "coveredRooms": 2})
        self.assertEqual(account["reconciliation"], {"matched": 1, "compared": 2, "rate": 0.5})
        self.assertEqual(result["groups"]["stores"][0]["sessions"], 2)
        self.assertEqual(result["groups"]["members"][0]["sessions"], 2)
        self.assertEqual(result["todos"][0]["actions"], "检查合成脚本")

    def test_unmapped_and_missing_values_are_not_treated_as_zero(self):
        rows = [self.row("one")]
        rows.append({**self.row("two", 20), "accountName": "其他来源"})
        result = build_team_overview(self.workspace.snapshot(), {"rows": rows, "total": 2}, [], available=True)
        self.assertEqual(result["unmappedSessions"], 1)
        self.assertIsNone(result["groups"]["accounts"][0]["watch"]["value"])
        self.assertIsNone(result["groups"]["accounts"][0]["reconciliation"]["rate"])

    def test_same_display_name_from_two_sources_is_not_attributed(self):
        rows = [{**self.row("one", 10), "accountId": "source-one"},
                {**self.row("two", 20), "accountId": "source-two"}]
        result = build_team_overview(self.workspace.snapshot(), {"rows": rows, "total": 2}, [])
        self.assertEqual(result["ambiguousSessions"], 2)
        self.assertEqual(result["unmappedSessions"], 2)
        self.assertEqual(result["groups"]["accounts"][0]["sessions"], 0)

    def test_same_display_name_in_account_inventory_is_ambiguous_even_before_second_room(self):
        business = {"rows": [{**self.row("one", 10), "accountId": "source-one"}], "total": 1,
                    "accounts": [{"id": "source-one", "name": "本机来源别名"},
                                 {"id": "source-two", "name": "本机来源别名"}]}
        result = build_team_overview(self.workspace.snapshot(), business, [])
        self.assertEqual(result["ambiguousSessions"], 1)
        self.assertEqual(result["groups"]["accounts"][0]["sessions"], 0)

    def test_manual_source_confirmation_audit_and_revoke(self):
        rows = [{**self.row("one", 10, refund_count=2, refund_amount=350), "accountId": "synthetic-source-one"},
                {**self.row("two", 20), "accountId": "synthetic-source-two"}]
        business = {"rows": rows, "total": 2, "accounts": [
            {"id": "synthetic-source-one", "name": "本机来源别名"},
            {"id": "synthetic-source-two", "name": "本机来源别名"}]}
        initial = build_team_overview(self.workspace.snapshot(), business, [])
        self.assertEqual(initial["ambiguousSessions"], 2)
        self.assertEqual(len(initial["sourceCandidates"]), 2)
        candidate = next(item for item in initial["sourceCandidates"] if item["sourceRef"] ==
                         self.workspace.source_ref("synthetic-source-one"))
        record = self.workspace.confirm_source(candidate["sourceRef"], candidate["sourceAlias"],
                                               self.mapping["id"], "合成确认人", initial["sourceCandidates"])
        confirmed = build_team_overview(self.workspace.snapshot(), business, [])
        self.assertEqual(confirmed["ambiguousSessions"], 1)
        self.assertEqual(confirmed["groups"]["accounts"][0]["sessions"], 1)
        self.assertEqual(confirmed["groups"]["stores"][0]["refundCount"], {"value": 2, "coveredRooms": 1})
        self.assertEqual(confirmed["groups"]["members"][0]["refundAmount"], {"value": 3.5, "coveredRooms": 1})
        self.assertEqual(record["confirmedBy"], "合成确认人")
        self.assertIn("confirmedAt", record)
        self.assertNotIn("synthetic-source-one", self.workspace.file.read_text(encoding="utf-8"))
        self.assertEqual(self.workspace.confirm_source(candidate["sourceRef"], candidate["sourceAlias"],
                                                       self.mapping["id"], "合成确认人", initial["sourceCandidates"])["id"], record["id"])
        self.workspace.revoke_source(record["id"], "合成撤销人")
        revoked = build_team_overview(self.workspace.snapshot(), business, [])
        self.assertEqual(revoked["ambiguousSessions"], 2)
        self.assertEqual(revoked["sourceConfirmations"][0]["revokedBy"], "合成撤销人")

    def test_source_confirmation_rejects_invalid_mapping_or_actor(self):
        business = {"rows": [{**self.row("one"), "accountId": "synthetic-a"},
                              {**self.row("two"), "accountId": "synthetic-b"}]}
        candidate = build_team_overview(self.workspace.snapshot(), business, [])["sourceCandidates"][0]
        with self.assertRaises(WorkspaceError):
            self.workspace.confirm_source(candidate["sourceRef"], candidate["sourceAlias"],
                                          self.mapping["id"], "123456789", [candidate])
        with self.assertRaises(WorkspaceError):
            self.workspace.confirm_source(candidate["sourceRef"], "错误来源", self.mapping["id"], "合成确认人", [candidate])
        with self.assertRaises(WorkspaceError):
            self.workspace.confirm_source(candidate["sourceRef"], candidate["sourceAlias"],
                                          "not-a-mapping", "合成确认人", [candidate])

    def test_mapping_requires_existing_local_relationships_and_unique_alias(self):
        with self.assertRaises(WorkspaceError):
            self.workspace.save("accountMappings", {"name": "重复", "sourceAlias": "本机来源别名", "active": True})
        with self.assertRaises(WorkspaceError):
            self.workspace.save("accountMappings", {"name": "错误", "sourceAlias": "另一个别名",
                                                    "memberId": "a" * 36, "active": True})
        for alias in ("123456789012345678", "https://example.invalid/account",
                      "token=synthetic-secret"):
            with self.subTest(alias=alias), self.assertRaises(WorkspaceError):
                self.workspace.save("accountMappings", {"name": "错误", "sourceAlias": alias, "active": True})
        self.assertEqual(len(self.workspace.snapshot()["accountMappings"]), 1)


if __name__ == "__main__":
    unittest.main()
