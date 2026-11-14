#!/usr/bin/env python3
"""Read-only iCloud CalDAV probe; Python standard library only."""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import getpass
import http.client
import json
import ssl
import sys
import warnings
from urllib.parse import urljoin, urlsplit
import xml.etree.ElementTree as ET

DAV = "DAV:"
CAL = "urn:ietf:params:xml:ns:caldav"
NS = {"d": DAV, "c": CAL}
START_URL = "https://caldav.icloud.com/"
MAX_BYTES = 8 * 1024 * 1024


class ProbeError(Exception):
    pass


def safe_url(base, href):
    url = urljoin(base, href)
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        valid = (parts.scheme == "https" and parts.port in (None, 443)
                 and parts.username is None and parts.password is None
                 and not parts.query and not parts.fragment
                 and (host == "icloud.com" or host.endswith(".icloud.com"))
                 and all(ord(char) >= 33 and ord(char) != 127 for char in href + url))
    except ValueError:
        valid = False
    if not valid:
        raise ProbeError("iCloud以外、または安全でない接続先を拒否しました。")
    return url


def properties(response):
    """Only successful WebDAV properties may influence discovery or results."""
    result = ET.Element("properties")
    for propstat in response.findall("d:propstat", NS):
        status = (propstat.findtext("d:status", "", NS)).split()
        if len(status) >= 2 and status[1] == "200":
            prop = propstat.find("d:prop", NS)
            if prop is not None:
                result.extend(prop)
    return result


class ICloudProbe:
    def __init__(self, account, password):
        self.authorization = "Basic " + base64.b64encode(
            f"{account}:{password}".encode("utf-8")).decode("ascii")

    def request(self, url, method, body, depth):
        url = safe_url(START_URL, url)
        for _ in range(4):
            parts = urlsplit(url)
            connection = http.client.HTTPSConnection(
                parts.hostname, timeout=30, context=ssl.create_default_context())
            try:
                connection.request(method, parts.path or "/", body.encode("utf-8"), {
                    "Authorization": self.authorization,
                    "Content-Type": "application/xml; charset=utf-8",
                    "Depth": str(depth),
                })
                response = connection.getresponse()
                if response.status in (301, 302, 307, 308):
                    location = response.getheader("Location")
                    if not location:
                        raise ProbeError("転送先がありません。")
                    url = safe_url(url, location)
                    continue
                if response.status in (401, 403):
                    raise ProbeError("認証に失敗しました。Apple Accountとアプリ用パスワードを確認してください。")
                if response.status != 207:
                    raise ProbeError(f"iCloudがHTTP {response.status}を返しました。")
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ProbeError("応答が検証用の上限8MiBを超えました。--daysを短くしてください。")
                root = ET.fromstring(data)
                if root.tag != f"{{{DAV}}}multistatus":
                    raise ProbeError("iCloudから予期しないXML応答を受信しました。")
                return url, root.findall("d:response", NS)
            except (OSError, http.client.HTTPException):
                raise ProbeError("iCloudへ接続できません。ネットワークとTLS証明書の検証環境を確認してください。") from None
            except ET.ParseError:
                raise ProbeError("iCloudのXML応答を解析できませんでした。") from None
            finally:
                connection.close()
        raise ProbeError("iCloudの転送回数が上限を超えました。")

    def discover_href(self, url, name):
        namespace, local = name.split(":", 1)
        body = (f'<d:propfind xmlns:d="{DAV}" xmlns:c="{CAL}">'
                f'<d:prop><{namespace}:{local}/></d:prop></d:propfind>')
        final_url, responses = self.request(url, "PROPFIND", body, 0)
        for response in responses:
            href = properties(response).findtext(f"{name}/d:href", "", NS)
            if href:
                return safe_url(final_url, href)
        raise ProbeError("iCloudのカレンダー接続情報を取得できませんでした。")

    def run(self, start, end):
        principal = self.discover_href(START_URL, "d:current-user-principal")
        home = self.discover_href(principal, "c:calendar-home-set")
        body = (f'<d:propfind xmlns:d="{DAV}" xmlns:c="{CAL}"><d:prop>'
                '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>'
                '</d:prop></d:propfind>')
        final_url, responses = self.request(home, "PROPFIND", body, 1)
        calendars = []
        for response in responses:
            prop = properties(response)
            if prop.find("d:resourcetype/c:calendar", NS) is None:
                continue
            if not any(item.get("name") == "VEVENT" for item in
                       prop.findall("c:supported-calendar-component-set/c:comp", NS)):
                continue
            href = response.findtext("d:href", "", NS)
            if not href:
                raise ProbeError("カレンダーの接続先がありません。")
            calendars.append((prop.findtext("d:displayname", "(unnamed)", NS),
                              safe_url(final_url, href)))
        results = []
        for name, url in calendars:
            body = (f'<c:calendar-query xmlns:d="{DAV}" xmlns:c="{CAL}">'
                    '<d:prop><c:calendar-data/></d:prop><c:filter>'
                    '<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
                    f'<c:time-range start="{start:%Y%m%dT%H%M%SZ}" end="{end:%Y%m%dT%H%M%SZ}"/>'
                    '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
            _, events = self.request(url, "REPORT", body, 1)
            count = 0
            for event in events:
                data = properties(event).findtext("c:calendar-data", "", NS)
                if "BEGIN:VEVENT" not in data:
                    raise ProbeError("予定データの読み取りに失敗しました。")
                count += 1
            results.append({"calendar": name, "event_resources": count})
        return results


def main():
    parser = argparse.ArgumentParser(description="iCloudの予定を読み取る接続検証（変更・保存なし）")
    parser.add_argument("--days", type=int, choices=range(1, 32), default=7,
                        metavar="1..31", help="現在から検索する日数（既定7日）")
    args = parser.parse_args()
    try:
        if not sys.stdin.isatty():
            raise ProbeError("認証情報は対話ターミナルで入力してください。")
        account = input("Apple Account: ").strip()
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("アプリ用パスワード（非表示）: ").strip()
        if not account or ":" in account or not password:
            raise ProbeError("Apple Accountとアプリ用パスワードを入力してください。")
        start = datetime.now(timezone.utc).replace(microsecond=0)
        end = start + timedelta(days=args.days)
        print(f"検索期間（UTC）: {start.isoformat()} / {end.isoformat()}")
        results = ICloudProbe(account, password).run(start, end)
        for result in results:
            print(json.dumps(result, ensure_ascii=True))
        print(f"読み取り成功: VEVENT対応カレンダー {len(results)} 件")
        if not results:
            print("対象カレンダーがないため、予定の読み取りは未検証です。")
        return 0
    except ProbeError as error:
        print(f"検証失敗: {error}", file=sys.stderr)
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("検証を中止しました（認証情報は保存していません）。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
