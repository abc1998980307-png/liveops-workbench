import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dependency_service import DependencyManager
from scripts.install import installation_lock
import server


class DependencyServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.manager = DependencyManager(self.root, Path(__file__).resolve().parents[1])
        platform = mock.patch('dependency_service.sys.platform', 'darwin')
        machine = mock.patch('dependency_service.platform.machine', return_value='arm64')
        platform.start()
        machine.start()
        self.addCleanup(platform.stop)
        self.addCleanup(machine.stop)

    def test_unsupported_platform_cannot_start_installer(self):
        with mock.patch('dependency_service.sys.platform', 'linux'), mock.patch('dependency_service.subprocess.Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'Apple Silicon'):
                self.manager.install()
            spawn.assert_not_called()

    def test_inventory_does_not_install_or_start_services(self):
        with mock.patch('dependency_service.subprocess.Popen') as spawn:
            state = self.manager.state()
        self.assertTrue(all(not item['found'] for item in state['items']))
        self.assertFalse(state['busy'])
        spawn.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_repeated_requests_share_one_installer_process(self):
        child = mock.Mock()
        child.poll.return_value = None
        with mock.patch('dependency_service.subprocess.Popen', return_value=child) as spawn:
            self.assertTrue(self.manager.install()['busy'])
            self.assertTrue(self.manager.install()['busy'])
            spawn.assert_called_once()
            argv = spawn.call_args.args[0]
            self.assertEqual(argv[-2:], ['--data-root', str(self.root)])
            self.assertNotIn('shell', spawn.call_args.kwargs)

    def test_cli_lock_is_detected_and_prevents_web_duplicate(self):
        with installation_lock(self.root), mock.patch('dependency_service.subprocess.Popen') as spawn:
            self.assertTrue(self.manager.install()['busy'])
            spawn.assert_not_called()

    def test_failed_installer_reports_error_and_bounds_log(self):
        child = mock.Mock()
        child.poll.return_value = 1
        self.manager.process = child
        self.manager.log.parent.mkdir(parents=True)
        self.manager.log.write_text('a' * 50000 + 'failure')
        state = self.manager.state()
        self.assertFalse(state['busy'])
        self.assertTrue(state['error'])
        self.assertLessEqual(len(state['log']), 6000)
        self.assertTrue(state['log'].endswith('failure'))


class DependencyHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.LocalHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.port = cls.http.server_address[1]
        cls.previous_port = server.PORT
        server.PORT = cls.port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.PORT = cls.previous_port

    def setUp(self):
        self.patch = mock.patch.object(server, 'DEPENDENCIES')
        self.manager = self.patch.start()
        self.addCleanup(self.patch.stop)
        self.manager.state.return_value = {'items': [], 'busy': False}
        self.manager.install.return_value = {'busy': True}

    def request(self, method='GET', payload=None, headers=None):
        client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        client.request(method, '/api/dependencies/' + ('state' if method == 'GET' else 'install'),
                       json.dumps(payload) if method == 'POST' else None,
                       {'Content-Type': 'application/json', **(headers or {})})
        response = client.getresponse()
        data = json.loads(response.read())
        client.close()
        return response.status, data

    def test_read_and_install_routes(self):
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request('POST', {})[1], {'busy': True})
        self.manager.install.assert_called_once_with()

    def test_cross_site_and_foreign_host_are_rejected(self):
        for method in ('GET', 'POST'):
            for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}):
                self.assertEqual(self.request(method, {}, headers)[0], 403)
        self.manager.state.assert_not_called()
        self.manager.install.assert_not_called()

    def test_no_custom_commands_directories_or_components_accepted(self):
        for body in ([], {'command': 'anything'}, {'root': '/tmp/elsewhere'}, {'components': ['unknown']}):
            self.assertEqual(self.request('POST', body)[0], 400)
        self.manager.install.assert_not_called()
