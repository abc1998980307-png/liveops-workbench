import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProfileCandidates, profilePayloadFromPage } from '../rpa/douyin-profile.mjs';

const secUserId = 'MS4wLjABAAAA1234567890';

test('page fallback keeps only the requested profile live-room fields', () => {
  const payload = profilePayloadFromPage([
    { sec_uid: 'another-profile-id', nickname: 'other', room_data: { status: 2, owner: { web_rid: '1111111111' } } },
    { sec_uid: secUserId, nickname: '主播', room_data: { status: 2, owner: { web_rid: '1234567890123456789' } } },
  ], secUserId);
  assert.deepEqual(payload, {
    status_code: 0,
    user: {
      nickname: '主播',
      room_data: { status: 2, web_rid: null, owner: { web_rid: '1234567890123456789' } },
      web_rid: null,
      web_rid_str: null,
    },
  });
});

test('page fallback preserves an explicitly empty room state and flags unsafe numeric IDs', () => {
  const offline = profilePayloadFromPage([{ sec_uid: secUserId, room_data: '' }], secUserId);
  assert.equal(offline.user.room_data, '');
  const unsafe = profilePayloadFromPage([{ sec_uid: secUserId, room_data: { status: 2, owner: { web_rid: 9007199254740992 } } }], secUserId);
  assert.equal(unsafe.user.room_data.owner.web_rid, '__unsafe_numeric_id__');
});

test('page fallback rejects invalid IDs, mismatched profiles and unknown state', () => {
  assert.equal(profilePayloadFromPage([{ room_data: { status: 2 } }], 'bad'), null);
  assert.equal(profilePayloadFromPage([{ sec_uid: 'different', room_data: { status: 2 } }], secUserId), null);
  assert.equal(profilePayloadFromPage([{ room_data: { status: 2 } }], secUserId), null);
  assert.equal(profilePayloadFromPage([{ nickname: '主播' }], secUserId), null);
});

test('page extractor reads room data from serialized router state', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  try {
    globalThis.window = { _ROUTER_DATA: { user: { sec_uid: secUserId, nickname: '主播', room_data: JSON.stringify({ status: 2, owner: { web_rid: '1234567890' } }) } } };
    globalThis.document = { scripts: [] };
    const candidates = extractProfileCandidates();
    assert.equal(profilePayloadFromPage(candidates, secUserId).user.room_data.owner.web_rid, '1234567890');
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});
