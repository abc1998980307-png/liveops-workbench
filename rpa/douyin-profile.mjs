const PROFILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

function safeRoomId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '__unsafe_numeric_id__';
  return value ?? null;
}

function compactRoomData(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return value; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const owner = value.owner && typeof value.owner === 'object' ? value.owner : {};
  return {
    status: value.status,
    web_rid: safeRoomId(value.web_rid),
    owner: { web_rid: safeRoomId(owner.web_rid) },
  };
}

export function profilePayloadFromPage(candidates, expectedSecUserId) {
  if (!PROFILE_ID_RE.test(String(expectedSecUserId)) || !Array.isArray(candidates)) return null;
  for (const candidate of candidates.slice(0, 50)) {
    if (!candidate || typeof candidate !== 'object' || !Object.hasOwn(candidate, 'room_data')) continue;
    const secUserId = candidate.sec_uid ?? candidate.sec_user_id;
    if (!secUserId || String(secUserId) !== expectedSecUserId) continue;
    return {
      status_code: 0,
      user: {
        nickname: typeof candidate.nickname === 'string' ? candidate.nickname.slice(0, 100) : '',
        room_data: compactRoomData(candidate.room_data),
        web_rid: safeRoomId(candidate.web_rid),
        web_rid_str: safeRoomId(candidate.web_rid_str),
      },
    };
  }
  return null;
}

export function extractProfileCandidates() {
  const safeId = (value) => typeof value === 'number' && !Number.isSafeInteger(value) ? '__unsafe_numeric_id__' : value ?? null;
  const compact = (value) => {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return value; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const owner = value.owner && typeof value.owner === 'object' ? value.owner : {};
    return { status: value.status, web_rid: safeId(value.web_rid), owner: { web_rid: safeId(owner.web_rid) } };
  };
  const candidates = [];
  const visited = new WeakSet();
  const queue = [];
  const keys = Object.keys(window).filter((key) => /router|initial|state|redux|loader/i.test(key)).slice(0, 80);
  for (const key of keys) {
    try { queue.push([window[key], `window.${key}`]); } catch {}
  }
  for (const script of document.scripts) {
    const text = script.textContent || '';
    if (!text || text.length > 3_000_000) continue;
    try { queue.push([JSON.parse(text), `script:${script.id || script.type || 'inline'}`]); } catch {}
  }

  let visitedCount = 0;
  while (queue.length && visitedCount++ < 30000 && candidates.length < 50) {
    const [value, source] = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value) && Object.hasOwn(value, 'room_data')) {
      candidates.push({
        sec_uid: value.sec_uid ?? value.sec_user_id ?? null,
        nickname: typeof value.nickname === 'string' ? value.nickname.slice(0, 100) : '',
        room_data: compact(value.room_data),
        web_rid: safeId(value.web_rid),
        web_rid_str: safeId(value.web_rid_str),
      });
    }
    const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
    for (const [key, child] of entries) {
      if (child && typeof child === 'object') queue.push([child, `${source}.${key}`]);
    }
  }
  return candidates;
}
