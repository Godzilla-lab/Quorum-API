"""The Python client, tested with no network at all.

Every test injects a transport, so the suite runs inside the same egress
blocked CI namespace as everything else. The behaviours under test are the
two decisions the client is built on: errors are values, and the server's
Retry-After sets the pace.
"""

import io
import json
import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quorum_api import ApiError, QuorumClient, Result  # noqa: E402


def transport_returning(status, body, headers=None):
    calls = []

    def transport(method, url, request_headers, payload, timeout):
        calls.append({
            "method": method, "url": url, "headers": request_headers,
            "body": payload, "timeout": timeout,
        })
        raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        return status, headers or {}, raw

    transport.calls = calls
    return transport


class CallShape(unittest.TestCase):
    def test_paths_headers_and_encoding(self):
        transport = transport_returning(200, {"ok": True})
        client = QuorumClient("https://api.example/", api_key="qk_test\n",
                              transport=transport)
        client.get_evidence("rc_abc/def")
        call = transport.calls[0]
        self.assertEqual(call["url"], "https://api.example/v1/evidence/rc_abc%2Fdef")
        self.assertEqual(call["headers"]["authorization"], "Bearer qk_test",
                         "a pasted newline never reaches the header")
        self.assertNotIn("content-type", call["headers"], "no body, no content type")

    def test_create_report_sends_only_what_was_given(self):
        transport = transport_returning(202, {"id": "rep_1", "status": "queued"})
        client = QuorumClient("https://api.example", transport=transport)
        result = client.create_report("running shoes", terms=["sizing"], offline=True)
        self.assertTrue(result.ok)
        sent = json.loads(transport.calls[0]["body"].decode("utf-8"))
        self.assertEqual(sent, {"subject": "running shoes", "terms": ["sizing"],
                                "offline": True},
                         "absent options are absent, not null")

    def test_keyless_sends_no_authorization(self):
        transport = transport_returning(200, {"ok": True})
        QuorumClient("https://api.example", transport=transport).healthz()
        self.assertNotIn("authorization", transport.calls[0]["headers"])


class ErrorsAreValues(unittest.TestCase):
    def test_server_error_body_travels_back(self):
        transport = transport_returning(429, {"error": {
            "type": "rate_limited", "message": "too many",
            "requestId": "req-1", "retryAfterSeconds": 30,
        }})
        result = QuorumClient("https://api.example", transport=transport).get_usage()
        self.assertFalse(result.ok)
        self.assertEqual(result.error.type, "rate_limited")
        self.assertEqual(result.error.status, 429)
        self.assertEqual(result.error.request_id, "req-1")
        self.assertEqual(result.error.retry_after_seconds, 30)

    def test_retry_after_header_wins_over_the_body(self):
        transport = transport_returning(
            503, {"error": {"type": "overloaded", "message": "shed",
                            "retryAfterSeconds": 99}},
            headers={"retry-after": "7"})
        result = QuorumClient("https://api.example", transport=transport).healthz()
        self.assertEqual(result.error.retry_after_seconds, 7,
                         "a proxy may add a header the app did not")

    def test_html_from_a_proxy_is_named_not_raised(self):
        transport = transport_returning(502, b"<html>bad gateway</html>")
        result = QuorumClient("https://api.example", transport=transport).healthz()
        self.assertFalse(result.ok)
        self.assertEqual(result.error.type, "bad_response")
        self.assertEqual(result.error.status, 502)

    def test_no_answer_at_all_is_status_zero(self):
        def transport(method, url, headers, body, timeout):
            raise OSError("connection refused")

        result = QuorumClient("https://api.example", transport=transport).healthz()
        self.assertFalse(result.ok)
        self.assertEqual(result.error.status, 0,
                         "no server is a different problem from any status code")
        self.assertEqual(result.error.type, "network")


class WaitForReport(unittest.TestCase):
    def test_polls_until_terminal_and_honours_retry_after(self):
        answers = [
            (503, {"error": {"type": "overloaded", "message": "shed"}}, {"retry-after": "5"}),
            (200, {"id": "rep_1", "status": "running"}, {}),
            (200, {"id": "rep_1", "status": "complete"}, {}),
        ]
        slept = []

        def transport(method, url, headers, body, timeout):
            status, payload, response_headers = answers.pop(0)
            return status, response_headers, json.dumps(payload).encode("utf-8")

        client = QuorumClient("https://api.example", transport=transport)
        result = client.wait_for_report("rep_1", poll_seconds=1.0,
                                        sleep=slept.append,
                                        clock=lambda: 0.0)
        self.assertTrue(result.ok)
        self.assertEqual(result.data["status"], "complete")
        self.assertEqual(slept[0], 5.0, "the 503's Retry-After set the first wait")
        self.assertEqual(slept[1], 1.0, "then the floor took over")

    def test_gives_up_honestly_with_the_last_status_seen(self):
        transport = transport_returning(200, {"id": "rep_1", "status": "running"})
        ticks = iter([0.0, 0.0, 1000.0])

        client = QuorumClient("https://api.example", transport=transport)
        result = client.wait_for_report("rep_1", timeout_seconds=10.0,
                                        sleep=lambda seconds: None,
                                        clock=lambda: next(ticks))
        self.assertFalse(result.ok)
        self.assertEqual(result.error.type, "timeout")
        self.assertIn("still running", result.error.message)

    def test_a_real_error_returns_immediately(self):
        transport = transport_returning(404, {"error": {
            "type": "not_found", "message": "no report carries this id"}})
        result = QuorumClient("https://api.example", transport=transport) \
            .wait_for_report("rep_x", sleep=lambda seconds: None)
        self.assertFalse(result.ok)
        self.assertEqual(result.error.type, "not_found")


class StreamReport(unittest.TestCase):
    def test_frames_survive_chunk_boundaries(self):
        raw = (b"id: 1\nevent: phase\ndata: {\"name\": \"retrieve\"}\n\n"
               b"id: 2\ndata: plain text\n\n")

        class Response(io.BytesIO):
            pass

        client = QuorumClient("https://api.example", api_key="k")
        events = list(client.stream_report(
            "rep_1", opener=lambda request, timeout: Response(raw)))
        self.assertEqual(events[0], {"id": 1, "type": "phase",
                                     "data": {"name": "retrieve"}})
        self.assertEqual(events[1], {"id": 2, "type": "message",
                                     "data": "plain text"})

    def test_a_stream_that_never_opens_is_empty_not_an_exception(self):
        def opener(request, timeout):
            raise OSError("refused")

        client = QuorumClient("https://api.example")
        self.assertEqual(list(client.stream_report("rep_1", opener=opener)), [])


class Shapes(unittest.TestCase):
    def test_result_and_error_are_plain_data(self):
        error = ApiError(type="x", message="y")
        self.assertEqual(error.status, 0)
        self.assertIsNone(Result(ok=True, data=1).error)


if __name__ == "__main__":
    unittest.main()


class SearchFilters(unittest.TestCase):
    def test_filters_map_to_the_wire_names(self):
        transport = transport_returning(200, {"records": []})
        client = QuorumClient("https://api.example", transport=transport)
        client.search_evidence(
            "sizing", category="running shoes", exclude_sources=["sec-edgar", "cpsc"],
            source_classes=["consumer_voice"], from_utc=1, until_utc=2,
            min_score=3, min_channels=2, mode="phrase",
        )
        sent = json.loads(transport.calls[0]["body"].decode("utf-8"))
        self.assertEqual(sent, {
            "query": "sizing", "category": "running shoes",
            "excludeSources": ["sec-edgar", "cpsc"],
            "sourceClasses": ["consumer_voice"],
            "from": 1, "until": 2, "minScore": 3, "minChannels": 2,
            "mode": "phrase",
        }, "snake_case in, camelCase on the wire, absent options absent")

    def test_bare_search_sends_only_the_query(self):
        transport = transport_returning(200, {"records": []})
        QuorumClient("https://api.example", transport=transport).search_evidence("sizing")
        sent = json.loads(transport.calls[0]["body"].decode("utf-8"))
        self.assertEqual(sent, {"query": "sizing"})
