import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from douyin_profile import ProfileLookupError, normalize_profile_link, profile_state_from_response


PROFILE_ID = "MS4wLjABAAAA1234567890"


class FakeResponse:
    def __init__(self, body=b"", url=""):
        self.body = body
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, size=-1):
        return self.body[:size]

    def geturl(self):
        return self.url


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.request = None

    def open(self, request, timeout):
        self.request = request
        self.timeout = timeout
        return self.response


class DouyinProfileTests(unittest.TestCase):
    def test_normalizes_standard_and_shared_profile_links(self):
        expected = {"secUserId": PROFILE_ID, "profileUrl": f"https://www.douyin.com/user/{PROFILE_ID}"}
        self.assertEqual(normalize_profile_link(f"https://www.douyin.com/user/{PROFILE_ID}/?from=share"), expected)
        self.assertEqual(normalize_profile_link(f"https://douyin.com/share/user/{PROFILE_ID}#tab"), expected)
        self.assertEqual(normalize_profile_link(f"https://www.iesdouyin.com/share/user/{PROFILE_ID}?from=copy"), expected)

    def test_resolves_douyin_short_link_and_rejects_external_redirect(self):
        expected_url = f"https://www.douyin.com/user/{PROFILE_ID}"
        opener = FakeOpener(FakeResponse(url=expected_url))
        self.assertEqual(normalize_profile_link("长按复制此条消息查看主页 https://v.douyin.com/AbCdEf/ 2@5.com :4pm", opener), {
            "secUserId": PROFILE_ID, "profileUrl": expected_url,
        })
        self.assertEqual(opener.timeout, 10)
        self.assertEqual(opener.request.full_url, "https://v.douyin.com/AbCdEf/")
        with self.assertRaisesRegex(ProfileLookupError, "抖音"):
            normalize_profile_link("https://v.douyin.com/AbCdEf/", FakeOpener(FakeResponse(url="https://127.0.0.1/user/anything")))

    def test_rejects_unsafe_hosts_and_non_profile_paths(self):
        for url in (
            "http://www.douyin.com/user/" + PROFILE_ID,
            "https://douyin.com.attacker.example/user/" + PROFILE_ID,
            "https://www.douyin.com.evil/user/" + PROFILE_ID,
            "https://user:pass@www.douyin.com/user/" + PROFILE_ID,
            "https://www.douyin.com/video/123456789",
        ):
            with self.subTest(url=url), self.assertRaises(ProfileLookupError):
                normalize_profile_link(url)

    def test_parses_live_room_and_offline_states(self):
        live = {
            "status_code": 0,
            "user": {
                "nickname": "主播",
                "room_data": json.dumps({"status": 2, "owner": {"web_rid": "1234567890"}}),
            },
        }
        self.assertEqual(profile_state_from_response(live), {
            "status": "live", "nickname": "主播", "roomUrl": "https://live.douyin.com/1234567890",
        })
        self.assertEqual(profile_state_from_response({"status_code": 0, "user": {"nickname": "主播", "room_data": ""}}), {
            "status": "offline", "nickname": "主播", "roomUrl": None,
        })
        self.assertEqual(profile_state_from_response({"status_code": 0, "user": {"room_data": {"status": 4}}})["status"], "offline")

    def test_rejects_unrecognized_status_and_invalid_user(self):
        for body in (
            {"status_code": 2, "status_msg": "UserId不合法", "user": {}},
            {"status_code": 0, "user": {"room_data": {"status": 7}}},
            {"status_code": 0, "user": {"room_data": {"status": 2}}},
        ):
            with self.subTest(body=body), self.assertRaises(ProfileLookupError):
                profile_state_from_response(body)

    def test_missing_status_and_unsafe_numeric_room_id_are_errors(self):
        with self.assertRaisesRegex(ProfileLookupError, "状态字段"):
            profile_state_from_response({"status_code": 0, "user": {"nickname": "主播"}})
        with self.assertRaisesRegex(ProfileLookupError, "精度"):
            profile_state_from_response({
                "status_code": 0,
                "user": {"room_data": {"status": 2, "owner": {"web_rid": 9007199254740992}}},
            })


if __name__ == "__main__":
    unittest.main()
