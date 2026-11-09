"""Resolve a Douyin profile URL to its current public live-room state."""

import json
import re
import urllib.error
import urllib.parse
import urllib.request


PROFILE_HOSTS = {"www.douyin.com", "douyin.com", "www.iesdouyin.com", "iesdouyin.com"}
SHORT_LINK_HOSTS = {"v.douyin.com"}
REDIRECT_HOSTS = PROFILE_HOSTS | SHORT_LINK_HOSTS
PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
LIVE_ID_RE = re.compile(r"^\d{1,30}$")
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class ProfileLookupError(RuntimeError):
    pass


def _validate_douyin_url(value):
    parsed = urllib.parse.urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise ProfileLookupError("主页链接格式无效") from error
    if (parsed.scheme != "https" or parsed.hostname not in REDIRECT_HOSTS
            or parsed.username or parsed.password or port not in (None, 443)):
        raise ProfileLookupError("请粘贴抖音主页链接或 v.douyin.com 分享短链")
    return parsed


class _DouyinRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if (parsed.scheme != "https" or parsed.hostname not in REDIRECT_HOSTS
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise ProfileLookupError("主页短链跳转到了非抖音域名，已拒绝访问")
        _validate_douyin_url(new_url)
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


def _profile_id_from_url(value):
    parsed = _validate_douyin_url(value)
    if parsed.hostname not in PROFILE_HOSTS:
        return None
    path = urllib.parse.unquote(parsed.path)
    match = re.fullmatch(r"/(?:user|share/user)/([A-Za-z0-9_-]{10,200})/?", path)
    if not match or not PROFILE_ID_RE.fullmatch(match.group(1)):
        raise ProfileLookupError("没有识别到抖音主页 ID，请复制个人主页分享链接")
    return match.group(1)


def normalize_profile_link(value, opener=None):
    if not isinstance(value, str) or len(value.strip()) > 2048:
        raise ProfileLookupError("主页链接无效")
    value = value.strip()
    candidates = [match.rstrip(".,，。!?！？;；:：)]}》") for match in URL_RE.findall(value)]
    if candidates:
        if len(candidates) != 1:
            raise ProfileLookupError("请只粘贴一个抖音主页链接")
        value = candidates[0]
    parsed = _validate_douyin_url(value)
    if parsed.hostname in PROFILE_HOSTS:
        sec_user_id = _profile_id_from_url(value)
    else:
        request = urllib.request.Request(value, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        redirect_opener = opener or urllib.request.build_opener(_DouyinRedirectHandler)
        try:
            with redirect_opener.open(request, timeout=10) as response:
                final_url = response.geturl()
        except ProfileLookupError:
            raise
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            raise ProfileLookupError("无法解析抖音主页短链，请粘贴主页完整链接") from error
        final = _validate_douyin_url(final_url)
        if final.hostname not in PROFILE_HOSTS:
            raise ProfileLookupError("主页短链没有跳转到抖音个人主页")
        sec_user_id = _profile_id_from_url(final_url)
    canonical = "https://www.douyin.com/user/" + urllib.parse.quote(sec_user_id, safe="")
    return {"secUserId": sec_user_id, "profileUrl": canonical}


def profile_state_from_response(body):
    if not isinstance(body, dict):
        raise ProfileLookupError("抖音主页接口返回格式异常")
    code = body.get("status_code")
    if code not in (None, 0, "0"):
        message = str(body.get("status_msg") or "").strip()
        if code == 2 or str(code) == "2":
            raise ProfileLookupError("抖音没有返回这个用户，请检查主页链接")
        raise ProfileLookupError(("抖音主页接口暂不可用：" + message)[:180])
    user = body.get("user")
    if not isinstance(user, dict) or not user:
        raise ProfileLookupError("抖音没有返回用户资料，请稍后重试")

    nickname = user.get("nickname")
    nickname = nickname.strip()[:100] if isinstance(nickname, str) else ""
    if "room_data" not in user:
        raise ProfileLookupError("抖音没有返回主页直播状态字段")
    room_data = user.get("room_data")
    if isinstance(room_data, str):
        if not room_data.strip():
            return {"status": "offline", "nickname": nickname, "roomUrl": None}
        else:
            try:
                room_data = json.loads(room_data)
            except ValueError as error:
                raise ProfileLookupError("抖音主页直播状态格式已变化") from error
    if room_data is None:
        raise ProfileLookupError("抖音主页直播状态为空")
    if not isinstance(room_data, dict):
        raise ProfileLookupError("抖音主页直播状态格式已变化")

    status = room_data.get("status")
    if status in (2, "2"):
        owner = room_data.get("owner") if isinstance(room_data.get("owner"), dict) else {}
        web_rid = owner.get("web_rid") or room_data.get("web_rid") or user.get("web_rid_str") or user.get("web_rid")
        if (isinstance(web_rid, int) and not isinstance(web_rid, bool)
                and not (-9007199254740991 <= web_rid <= 9007199254740991)):
            raise ProfileLookupError("抖音返回的直播间 ID 精度不可靠")
        if web_rid is None or not LIVE_ID_RE.fullmatch(str(web_rid)):
            raise ProfileLookupError("检测到正在直播，但抖音没有返回可用的直播间 ID")
        return {
            "status": "live",
            "nickname": nickname,
            "roomUrl": "https://live.douyin.com/" + str(web_rid),
        }
    if status in (0, 4, "0", "4"):
        return {"status": "offline", "nickname": nickname, "roomUrl": None}
    raise ProfileLookupError("无法确认抖音主页当前直播状态")
