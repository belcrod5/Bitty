import contextlib
from datetime import datetime, timedelta, timezone
import io
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import icloud_probe as probe


def response(href, prop, status="200 OK"):
    return (f'<d:response><d:href>{href}</d:href><d:propstat><d:prop>{prop}</d:prop>'
            f'<d:status>HTTP/1.1 {status}</d:status></d:propstat></d:response>')


def multistatus(*responses):
    return (f'<d:multistatus xmlns:d="DAV:" xmlns:c="{probe.CAL}">'
            + "".join(responses) + '</d:multistatus>').encode()


class FakeResponse:
    def __init__(self, data=b"", status=207, location=None):
        self.status, self.data, self.location = status, data, location

    def read(self, limit):
        return self.data[:limit]

    def getheader(self, name):
        return self.location


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.probe = probe.ICloudProbe("test@example.invalid", "secret-for-test")
        self.requests = []
        self.responses = []
        self.connection_patch = patch.object(probe.http.client, "HTTPSConnection", self.connect)
        self.connection_patch.start()
        self.addCleanup(self.connection_patch.stop)

    def connect(self, host, **kwargs):
        self.assertTrue(kwargs["context"].check_hostname)
        case = self

        class Connection:
            def request(self, method, path, data, headers):
                case.requests.append((host, method, path, data, headers))

            def getresponse(self):
                return case.responses.pop(0)

            def close(self):
                pass

        return Connection()

    def fixtures(self, principal="/principal/", calendar="https://p01-caldav.icloud.com/home/work/"):
        self.responses = [
            FakeResponse(multistatus(response("/", f'<d:current-user-principal><d:href>{principal}</d:href></d:current-user-principal>'))),
            FakeResponse(multistatus(response("/principal/", '<c:calendar-home-set><d:href>https://p01-caldav.icloud.com/home/</d:href></c:calendar-home-set>'))),
            FakeResponse(multistatus(
                response(calendar, '<d:displayname>Work &amp; Life</d:displayname><d:resourcetype><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'),
                response("/home/tasks/", '<d:resourcetype><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>'),
                response("https://evil.invalid/", '<d:resourcetype><c:calendar/></d:resourcetype>', "404 Not Found"))),
            FakeResponse(multistatus(response("/home/work/event.ics", '<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:private title\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>'))),
        ]

    def run_probe(self):
        start = datetime(2026, 11, 14, tzinfo=timezone.utc)
        return self.probe.run(start, start + timedelta(days=7))

    def test_full_discovery_and_event_read(self):
        self.fixtures()
        self.assertEqual(self.run_probe(), [{"calendar": "Work & Life", "event_resources": 1}])
        self.assertEqual([r[1] for r in self.requests], ["PROPFIND"] * 3 + ["REPORT"])
        self.assertEqual([r[0] for r in self.requests], ["caldav.icloud.com"] * 2 + ["p01-caldav.icloud.com"] * 2)
        report = ET.fromstring(self.requests[-1][3])
        self.assertEqual(report.find(".//c:time-range", probe.NS).attrib,
                         {"start": "20261114T000000Z", "end": "20261121T000000Z"})
        self.assertEqual(self.responses, [])

    def test_unsafe_urls_rejected_before_any_credentials_sent(self):
        for url in ("https://icloud.com.evil.invalid/", "https://evilicloud.com/",
                    "http://caldav.icloud.com/", "https://u@icloud.com/", "https://@icloud.com/",
                    "https://icloud.com:444/", "https://icloud.com:bad/", "https://icloud.com/a\n",
                    "https://icloud.com/?query=1", "https://icloud.com/#fragment"):
            with self.subTest(url=url), self.assertRaises(probe.ProbeError):
                self.probe.request(url, "PROPFIND", "", 0)
        self.assertEqual(self.requests, [])

    def test_unsafe_discovery_hrefs_never_receive_auth(self):
        self.fixtures(principal="https://evil.invalid/principal/")
        with self.assertRaises(probe.ProbeError):
            self.run_probe()
        self.assertEqual(len(self.requests), 1)
        self.fixtures(calendar="https://evil.invalid/calendar/")
        with self.assertRaises(probe.ProbeError):
            self.run_probe()
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all(r[0].endswith("icloud.com") for r in self.requests))

    def test_redirect_keeps_read_method_and_checks_destination(self):
        self.responses = [FakeResponse(status=302, location="https://p02-caldav.icloud.com/"),
                          FakeResponse(multistatus())]
        self.probe.request(probe.START_URL, "PROPFIND", "body", 0)
        self.assertEqual([r[1:4] for r in self.requests], [("PROPFIND", "/", b"body")] * 2)
        self.responses = [FakeResponse(status=307, location="https://evil.invalid/")]
        with self.assertRaises(probe.ProbeError):
            self.probe.request(probe.START_URL, "PROPFIND", "", 0)
        self.assertEqual(len(self.requests), 3)

    def test_failure_messages_do_not_expose_response_or_secrets(self):
        for status, data in ((401, b"secret-for-test"), (403, b"secret-for-test"),
                             (500, b"test@example.invalid"), (207, b"malformed secret-for-test"),
                             (207, b"<other/>")):
            self.responses = [FakeResponse(data, status)]
            with self.subTest(status=status), self.assertRaises(probe.ProbeError) as error:
                self.probe.request(probe.START_URL, "PROPFIND", "", 0)
            self.assertNotIn("secret-for-test", str(error.exception))
            self.assertNotIn("test@example.invalid", str(error.exception))

    def test_failed_principal_property_is_not_used(self):
        self.responses = [FakeResponse(multistatus(response("/", '<d:current-user-principal><d:href>https://evil.invalid/</d:href></d:current-user-principal>', "404 Not Found")))]
        with self.assertRaisesRegex(probe.ProbeError, "接続情報"):
            self.run_probe()
        self.assertEqual(len(self.requests), 1)

    def test_failed_event_property_is_not_reported_as_success(self):
        self.fixtures()
        self.responses[-1] = FakeResponse(multistatus(response("/event.ics", '<c:calendar-data/>', "403 Forbidden")))
        with self.assertRaisesRegex(probe.ProbeError, "予定データ"):
            self.run_probe()

    def test_empty_period_is_valid(self):
        self.fixtures()
        self.responses[-1] = FakeResponse(multistatus())
        self.assertEqual(self.run_probe()[0]["event_resources"], 0)

    def test_network_error_is_sanitized(self):
        with patch.object(probe.http.client, "HTTPSConnection") as connection:
            connection.return_value.request.side_effect = OSError("secret-for-test")
            with self.assertRaisesRegex(probe.ProbeError, "接続できません") as error:
                self.probe.request(probe.START_URL, "PROPFIND", "", 0)
            self.assertNotIn("secret-for-test", str(error.exception))

    def test_noninteractive_input_fails_before_reading_credentials(self):
        with patch.object(probe.sys, "argv", ["icloud_probe.py"]), \
                patch.object(probe.sys.stdin, "isatty", return_value=False), \
                patch.object(probe.getpass, "getpass") as password, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(probe.main(), 1)
            password.assert_not_called()


if __name__ == "__main__":
    unittest.main()
