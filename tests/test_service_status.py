import copy
import http.client
import json
import sys
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service_status import compass_status, feishu_status
import server

NOW = 1794238500
RECENT = '2026-11-09T15:34:00Z'


class SourceStatusTests(unittest.TestCase):
    def account(self, **changes):
        return {"uid": "synthetic-account", "enabled": True, "state": "ready", "interval": 3600,
                "lastCheck": RECENT, "lastSync": RECENT, **changes}

    def status(self, *accounts):
        return compass_status({"accounts": list(accounts)}, now=NOW)

    def test_paused_identified_accounts_are_neither_login_failures_nor_currently_connected(self):
        result = self.status(self.account(enabled=False, state='paused'))
        self.assertEqual(result['state'], 'paused')
        self.assertEqual(result['label'], '采集已暂停')
        self.assertFalse(result['connected'])
        self.assertIn('恢复后再检查', result['note'])
        self.assertEqual(result['lastCheck'], RECENT)

    def test_login_failure_and_one_shot_sync_failure_remain_visible_when_disabled(self):
        for state, expected in [('needs_login','needs_login'), ('account_changed','account_changed'),
                                ('error','error'), ('partial','error'), ('rate_limited','rate_limited')]:
            with self.subTest(state=state):
                self.assertEqual(self.status(self.account(state=state,enabled=False))['state'], expected)

    def test_old_identity_or_timestamp_never_claims_fresh_connection(self):
        for changes in ({'lastSync':None}, {'lastCheck':None}, {'uid':None},
                        {'lastCheck':'2026-11-08T15:34:00Z'}, {'lastSync':'2026-11-08T15:34:00Z'},
                        {'lastCheck':'2026-11-10T15:34:00Z'}, {'lastCheck':'broken'},
                        {'lastCheck':'2026-11-09T15:34:00'}):
            result=self.status(self.account(**changes))
            self.assertEqual(result['state'],'stale')
            self.assertFalse(result['connected'])
        self.assertEqual(self.status(self.account())['state'],'ready')
        self.assertTrue(self.status(self.account())['connected'])

    def test_hourly_interval_uses_three_hour_freshness_window(self):
        recent='2026-11-09T13:35:00Z'
        stale='2026-11-09T12:30:00Z'
        self.assertEqual(self.status(self.account(lastCheck=recent,lastSync=recent))['state'],'ready')
        self.assertEqual(self.status(self.account(lastCheck=stale,lastSync=stale))['state'],'stale')
        self.assertEqual(self.status(self.account(interval=60,lastCheck=recent,lastSync=recent))['state'],'ready')

    def test_mixed_accounts_partial_and_busy_are_explicit(self):
        paused=self.account(enabled=False,state='paused')
        result=self.status(self.account(),paused)
        self.assertEqual(result['state'],'ready')
        self.assertEqual(result['counts']['paused'],1)
        self.assertIn('另有 1 个账号暂停',result['note'])
        self.assertEqual(self.status(self.account(),self.account(state='needs_login'))['state'],'partial')
        self.assertEqual(self.status(self.account(enabled=False,busy=True))['state'],'checking')
        self.assertEqual(self.status()['state'],'unconfigured')

    def test_summary_contains_no_account_identifiers_names_or_rooms(self):
        a=self.account(name='private business name',rooms=[{'id':'private room'}])
        original=copy.deepcopy(a)
        result=json.dumps(self.status(a))
        for text in ['synthetic-account','private business name','private room']:
            self.assertNotIn(text,result)
        self.assertEqual(a,original)
        for payload in [None,{}, {'accounts':{}},{'accounts':[None]}]:
            with self.assertRaises(ValueError):compass_status(payload)

    def test_feishu_configured_but_empty_is_waiting_not_a_successful_write(self):
        base={'configured':True,'verified':True,'enabled':True,'pending':0,'synced':0,'lastSuccess':None}
        self.assertEqual(feishu_status(base)['state'],'waiting_data')
        for changes,state in [({'configured':False},'unconfigured'),({'enabled':False},'paused'),
                              ({'verified':False},'unverified'),({'pending':2},'pending'),
                              ({'lastSuccess':RECENT,'synced':1},'ready'),({'busy':True},'checking'),
                              ({'error':'rate limit'},'error')]:
            with self.subTest(state=state):self.assertEqual(feishu_status({**base,**changes})['state'],state)
        result=feishu_status({**base,'appSecret':'must not leak','url':'private target'})
        self.assertNotIn('must not leak',json.dumps(result))
        self.assertNotIn('private target',json.dumps(result))


class SourceStatusHTTPTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.http=server.LocalHTTPServer(('127.0.0.1',0),server.Handler)
        self.port=self.http.server_address[1]
        self.stack.enter_context(mock.patch.object(server,'PORT',self.port))
        self.collector=self.stack.enter_context(mock.patch.object(server,'COLLECTOR'))
        self.collector.call.side_effect=lambda method,**kwargs: ({'accounts':[{'enabled':False,'state':'paused','uid':'private-id'}]} if method=='state' else {'configured':True,'enabled':True,'verified':True,'pending':0,'synced':0})
        self.stack.enter_context(mock.patch.object(server,'service_request',return_value={'app_version':'test'}))
        hot=self.stack.enter_context(mock.patch.object(server,'HOTWORDS'))
        hot.state.return_value={'connected':True,'installed':True,'dataReady':False,'updatedAt':None,'error':None,'dataError':'upstream unavailable'}
        keywords=self.stack.enter_context(mock.patch.object(server,'KEYWORDS'));keywords.state.return_value={'installed':True}
        media=self.stack.enter_context(mock.patch.object(server,'MEDIA_PIPELINE'));media.job_snapshot.return_value={'transcriptionReady':True}
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.http.shutdown();self.http.server_close();self.thread.join()

    def request(self,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=3)
        c.request('GET','/api/status',headers=headers or {})
        r=c.getresponse();status=r.status;value=json.loads(r.read());c.close();return status,value

    def test_status_checks_only_local_state_and_preserves_independent_components(self):
        status,result=self.request();self.assertEqual(status,200)
        self.assertEqual(result['services']['compass']['state'],'paused')
        self.assertEqual(result['services']['feishu']['state'],'waiting_data')
        self.assertTrue(result['services']['playwright']['connected'])
        self.assertEqual([c.args[0] for c in self.collector.call.call_args_list],['state','feishu.state'])
        self.assertNotIn('private-id',json.dumps(result))
        self.collector.call.side_effect=RuntimeError('collector offline')
        status,result=self.request();self.assertEqual(status,200)
        self.assertEqual(result['services']['compass']['state'],'unknown')
        self.assertFalse(result['services']['playwright']['connected'])
        self.assertTrue(result['services']['bililive']['connected'])
        self.assertTrue(result['services']['keybert']['connected'])
        self.assertEqual(result['services']['feishu']['state'],'unknown')

    def test_status_rejects_foreign_origin_without_starting_collector(self):
        for headers in [{'Origin':'https://attacker.example'},{'Host':'attacker.example'}]:
            self.assertEqual(self.request(headers)[0],403)
        self.collector.call.assert_not_called()


if __name__=='__main__':unittest.main()
