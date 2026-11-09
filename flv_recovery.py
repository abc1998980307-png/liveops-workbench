"""Locate one incomplete final AVC packet without changing a recording."""

from pathlib import Path


def inspect_tail(path, cancelled=lambda: False):
    """Return a bounded prefix only for a single broken final H.264 packet.

    Container errors, unsupported video, damage before the end, or valid files
    are refused. A repaired output must still pass full strict media decoding.
    """
    path = Path(path)
    size = path.stat().st_size
    width = None
    bad = None
    last_good_time = None
    video_packets = 0
    with path.open("rb") as source:
        header = source.read(9)
        if len(header) != 9 or header[:3] != b"FLV" or header[3] != 1:
            raise ValueError("仅支持 FLV 中最后一个 H.264 残包的恢复")
        offset = int.from_bytes(header[5:9], "big")
        if not 9 <= offset <= min(size - 4, 1024 * 1024):
            raise ValueError("FLV 文件头异常，未修改原件")
        source.seek(offset)
        if source.read(4) != b"\0\0\0\0":
            raise ValueError("FLV 起始标签异常，未修改原件")
        offset += 4
        while offset < size:
            if cancelled():
                raise InterruptedError("恢复检查已暂停")
            source.seek(offset)
            header = source.read(11)
            if len(header) != 11 or header[0] not in {8, 9, 18} or header[8:11] != b"\0\0\0":
                raise ValueError("发现不支持的 FLV 标签或容器损坏，未修改原件")
            kind = header[0]
            length = int.from_bytes(header[1:4], "big")
            timestamp = (int.from_bytes(header[4:7], "big") + (header[7] << 24)) / 1000
            body = offset + 11
            end = body + length
            first = source.read(min(length, 10))
            complete = end + 4 <= size
            if bad:
                # FFmpeg may append exactly one AVC end-of-sequence tag.
                if not (complete and kind == 9 and length == 5 and len(first) == 5
                        and first[0] & 15 == 7 and first[1] == 2 and end + 4 == size):
                    raise ValueError("损坏包后仍有内容，无法只恢复末尾；原件保留")
            elif kind == 9:
                if len(first) < 5 or first[0] & 128 or first[0] & 15 != 7:
                    raise ValueError("视频编码不是支持的 H.264，原件保留")
                if first[1] == 0:
                    if not complete or len(first) < 10:
                        raise ValueError("H.264 配置不完整，原件保留")
                    width = (first[9] & 3) + 1
                    if width not in {1, 2, 4}:
                        raise ValueError("H.264 长度格式不支持")
                elif first[1] == 1:
                    if width is None:
                        raise ValueError("缺少 H.264 配置，原件保留")
                    cursor = body + 5
                    available_end = min(end, size)
                    malformed = not complete
                    while cursor < available_end:
                        source.seek(cursor)
                        raw = source.read(min(width, available_end - cursor))
                        nal_length = int.from_bytes(raw, "big")
                        if len(raw) != width or not nal_length or nal_length > available_end - cursor - width:
                            malformed = True
                            break
                        cursor += width + nal_length
                    if cursor == body + 5:
                        malformed = True
                    if malformed:
                        bad = {"prefixBytes": offset, "removedBytes": size - offset,
                               "packetTimeSeconds": timestamp, "lastGoodVideoTimeSeconds": last_good_time,
                               "reason": "最后一个 H.264 数据包不完整"}
                    else:
                        last_good_time = timestamp
                        video_packets += 1
                elif first[1] != 2:
                    raise ValueError("H.264 包类型不支持，原件保留")
            if not complete:
                if not bad or bad["prefixBytes"] != offset or end + 4 <= size:
                    raise ValueError("容器末尾不完整，无法确认仅损坏视频包")
                break
            source.seek(end)
            if int.from_bytes(source.read(4), "big") != length + 11:
                raise ValueError("FLV 标签边界损坏，原件保留")
            offset = end + 4
    if not bad or not video_packets:
        raise ValueError("未找到可安全隔离的末尾残包；请使用普通重试")
    return bad
