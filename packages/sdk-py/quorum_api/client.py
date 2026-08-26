"""The client. See the package docstring for the two decisions that shape it."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple
from urllib.parse import quote

# What a transport returns: status, lowercased headers, body bytes.
TransportResponse = Tuple[int, Dict[str, str], bytes]
# (method, url, headers, body bytes or None, timeout seconds) -> response.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], TransportResponse]


@dataclass
class ApiError:
    """The server's machine readable failure, or the absence of a server.

    type is the server's class: rate_limited, not_found, queue_saturated,
    unauthorized, bad_request, conflict; or this client's own two, network
    and timeout, when the request never got an answer. status is the HTTP
    status, or 0 when nothing answered at all, which is a different problem
    from any status code and a caller should be able to tell them apart.
    """

    type: str
    message: str
    request_id: Optional[str] = None
    # Present on 429 and 503. Seconds. Honour it.
    retry_after_seconds: Optional[float] = None
    status: int = 0


@dataclass
class Result:
    """ok with data, or not ok with error. Never both, never neither."""

    ok: bool
    data: Any = None
    error: Optional[ApiError] = None


def _failure(status: int, kind: str, message: str,
             request_id: Optional[str] = None,
             retry_after: Optional[float] = None) -> Result:
    return Result(ok=False, error=ApiError(
        type=kind, message=message, request_id=request_id,
        retry_after_seconds=retry_after, status=status,
    ))


def _default_transport(method: str, url: str, headers: Dict[str, str],
                       body: Optional[bytes], timeout: float) -> TransportResponse:
    request = urllib.request.Request(url, data=body, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return (response.status,
                    {k.lower(): v for k, v in response.headers.items()},
                    response.read())
    except urllib.error.HTTPError as err:
        # urllib raises on any non-2xx. The status and body are still the
        # server speaking, so they travel back as a response, not an error.
        return (err.code,
                {k.lower(): v for k, v in (err.headers or {}).items()},
                err.read())


class QuorumClient:
    """One instance per base URL and key.

    The base URL is supplied by the caller and never hardcoded. That is what
    makes this a client for YOUR instance rather than a vendor client: the
    address is configuration, hosted or self hosted alike.
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None,
                 timeout_seconds: float = 30.0,
                 transport: Optional[Transport] = None) -> None:
        self._base = base_url.rstrip("/") + "/v1"
        # Trimmed for the reason learned three times on 2026-08-24: a pasted
        # key carries a newline, and an untrimmed one dies at the header.
        self._api_key = api_key.strip() if api_key else None
        self._timeout = timeout_seconds
        self._transport = transport or _default_transport

    def _headers(self, has_body: bool) -> Dict[str, str]:
        headers = {"accept": "application/json"}
        if has_body:
            headers["content-type"] = "application/json"
        if self._api_key:
            headers["authorization"] = "Bearer " + self._api_key
        return headers

    def _call(self, method: str, path: str, body: Any = None) -> Result:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        try:
            status, headers, raw = self._transport(
                method, self._base + path, self._headers(payload is not None),
                payload, self._timeout)
        except Exception as cause:  # noqa: BLE001 - errors are values here.
            kind = "timeout" if "timed out" in str(cause).lower() else "network"
            return _failure(0, kind, str(cause))

        text = raw.decode("utf-8", errors="replace") if raw else ""
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            # A proxy returning HTML is the common case here, and a raw json
            # parse error would send somebody debugging this client.
            return _failure(status, "bad_response",
                            "the server returned %d with a body that is not json" % status)

        if 200 <= status < 300:
            return Result(ok=True, data=parsed)

        err = (parsed or {}).get("error") if isinstance(parsed, dict) else None
        err = err if isinstance(err, dict) else {}
        # The header wins over the body: a proxy may add one the app did not.
        header = headers.get("retry-after")
        retry = None
        if header is not None:
            try:
                retry = float(header)
            except ValueError:
                retry = None
        if retry is None:
            retry = err.get("retryAfterSeconds")
        return _failure(status,
                        err.get("type") or "http_error",
                        err.get("message") or ("the server returned %d" % status),
                        err.get("requestId"),
                        retry)

    # --- reports, the slow path ---

    def create_report(self, subject: str, *, terms: Optional[List[str]] = None,
                      communities: Optional[List[str]] = None,
                      sources: Optional[List[str]] = None,
                      include_ads: Optional[bool] = None,
                      offline: Optional[bool] = None,
                      cap_usd: Optional[float] = None,
                      deadline_ms: Optional[int] = None,
                      webhook_url: Optional[str] = None) -> Result:
        body: Dict[str, Any] = {"subject": subject}
        for key, value in (("terms", terms), ("communities", communities),
                           ("sources", sources), ("includeAds", include_ads),
                           ("offline", offline), ("capUsd", cap_usd),
                           ("deadlineMs", deadline_ms), ("webhookUrl", webhook_url)):
            if value is not None:
                body[key] = value
        return self._call("POST", "/reports", body)

    def get_report(self, report_id: str) -> Result:
        return self._call("GET", "/reports/" + quote(report_id, safe=""))

    def cancel_report(self, report_id: str) -> Result:
        return self._call("DELETE", "/reports/" + quote(report_id, safe=""))

    # --- evidence, the fast path ---

    def get_evidence(self, receipt_id: str) -> Result:
        return self._call("GET", "/evidence/" + quote(receipt_id, safe=""))

    def get_evidence_batch(self, receipt_ids: List[str]) -> Result:
        return self._call("POST", "/evidence/batch", {"receiptIds": receipt_ids})

    def search_evidence(self, query: str, *, category: Optional[str] = None,
                        limit: Optional[int] = None,
                        min_score: Optional[int] = None,
                        from_utc: Optional[int] = None,
                        until_utc: Optional[int] = None,
                        sources: Optional[List[str]] = None,
                        exclude_sources: Optional[List[str]] = None,
                        source_classes: Optional[List[str]] = None,
                        min_channels: Optional[int] = None,
                        mode: Optional[str] = None) -> Result:
        """Search held evidence, with the same filters the API takes.

        Snake_case here, camelCase on the wire, same names and semantics as
        the REST and MCP surfaces so the filter vocabulary cannot drift per
        surface. Dates are unix seconds over when the record was WRITTEN;
        undated records sit inside no window. mode="phrase" matches the
        words as one ordered phrase with no any-word fallback.
        """
        body: Dict[str, Any] = {"query": query}
        if category is not None:
            body["category"] = category
        if limit is not None:
            body["limit"] = limit
        if min_score is not None:
            body["minScore"] = min_score
        if from_utc is not None:
            body["from"] = from_utc
        if until_utc is not None:
            body["until"] = until_utc
        if sources is not None:
            body["sources"] = sources
        if exclude_sources is not None:
            body["excludeSources"] = exclude_sources
        if source_classes is not None:
            body["sourceClasses"] = source_classes
        if min_channels is not None:
            body["minChannels"] = min_channels
        if mode is not None:
            body["mode"] = mode
        return self._call("POST", "/evidence/search", body)

    def get_ad_evidence(self, ad_id: str) -> Result:
        return self._call("GET", "/evidence/ads/" + quote(ad_id, safe=""))

    def get_category(self, slug: str) -> Result:
        return self._call("GET", "/categories/" + quote(slug, safe=""))

    def list_categories(self) -> Result:
        return self._call("GET", "/categories")

    # --- verification and account ---

    def verify_claims(self, claims: List[Dict[str, Any]]) -> Result:
        """Re-resolve every cited id against the corpus, ours or anybody's.

        A claim citing an id that does not exist is reported rather than
        quietly passed, which is the point of the whole product.
        """
        return self._call("POST", "/verify", {"claims": claims})

    def get_usage(self) -> Result:
        return self._call("GET", "/usage")

    def healthz(self) -> Result:
        return self._call("GET", "/healthz")

    # --- the loop every caller would otherwise write badly ---

    def wait_for_report(self, report_id: str, *,
                        timeout_seconds: float = 900.0,
                        poll_seconds: float = 2.0,
                        on_poll: Optional[Callable[[Any], None]] = None,
                        sleep: Callable[[float], None] = time.sleep,
                        clock: Callable[[], float] = time.monotonic) -> Result:
        """Poll a report to completion, honouring the server's own pacing.

        Three things this gets right that a naive loop does not: a 503 is the
        load shedder speaking, not a failure; the server sets the pace through
        Retry-After rather than the client guessing; and on timeout it returns
        the last status it saw rather than pretending the report failed.
        """
        deadline = clock() + timeout_seconds
        last_status: Optional[str] = None

        while True:
            result = self.get_report(report_id)

            if result.ok:
                data = result.data if isinstance(result.data, dict) else {}
                last_status = data.get("status")
                if on_poll is not None:
                    on_poll(result.data)
                if last_status not in ("queued", "running"):
                    return result
                suggested = None
            elif result.error is not None and result.error.status in (429, 503):
                suggested = result.error.retry_after_seconds
            else:
                # A real error. Anything else was the server asking us to wait.
                return result

            wait = max(poll_seconds, float(suggested or 0))
            if clock() + wait > deadline:
                message = ("gave up after the deadline with the report still %s" % last_status
                           if last_status else
                           "gave up after the deadline without reaching the server")
                return _failure(0, "timeout", message)
            sleep(wait)

    def stream_report(self, report_id: str,
                      opener: Optional[Callable[[urllib.request.Request, float], Any]] = None,
                      ) -> Iterator[Dict[str, Any]]:
        """Yield a running report's server sent events as dicts.

        Parsed by hand for the same reason the JavaScript SDK parses by hand:
        the frame is id, event and data lines terminated by a blank line, and
        a chunk boundary can fall anywhere, so the buffer is drained on
        complete frames only. A transport level failure ends the stream
        rather than raising, because a dropped stream is a normal way for a
        finished report to say goodbye.
        """
        request = urllib.request.Request(
            self._base + "/reports/" + quote(report_id, safe="") + "/stream")
        for name, value in self._headers(False).items():
            request.add_header(name, "text/event-stream" if name == "accept" else value)

        open_stream = opener or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))
        try:
            response = open_stream(request, self._timeout)
        except Exception:  # noqa: BLE001 - a stream that never opened is empty.
            return

        buffer = ""
        try:
            while True:
                chunk = response.read(1024)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    event = _parse_frame(frame)
                    if event is not None:
                        yield event
        except Exception:  # noqa: BLE001
            return
        finally:
            close = getattr(response, "close", None)
            if close is not None:
                close()


def _parse_frame(frame: str) -> Optional[Dict[str, Any]]:
    event_id = 0
    kind = "message"
    data: List[str] = []
    for line in frame.split("\n"):
        if line.startswith("id:"):
            try:
                event_id = int(line[3:].strip())
            except ValueError:
                event_id = 0
        elif line.startswith("event:"):
            kind = line[6:].strip()
        elif line.startswith("data:"):
            # Multiple data lines in one frame concatenate, per the SSE spec.
            data.append(line[5:].strip())
    if not data:
        return None
    joined = "\n".join(data)
    try:
        return {"id": event_id, "type": kind, "data": json.loads(joined)}
    except ValueError:
        return {"id": event_id, "type": kind, "data": joined}
