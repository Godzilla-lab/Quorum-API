"""quorum-api. The typed Python client for the hosted API.

WRITTEN AGAINST spec/openapi.yaml, WHICH IS THE CONTRACT. Every method here is
one operationId from that file, and the spec wins when they disagree.

THE SAME TWO DECISIONS THE JAVASCRIPT SDK MADE, for the same reasons.

ERRORS ARE VALUES, NEVER RAISED. The house rule everywhere a vendor can be
down, and an SDK IS the place a vendor can be down. A caller gets a Result
whose error carries the server's type, message and requestId rather than an
exception, because the interesting failures here are a 429, a 503 with a
Retry-After, and a report that is simply not finished, and none of those are
exceptional.

IT HONOURS RETRY-AFTER. The server sheds under load with a 503 and rate
limits with a 429, both carrying the wait. wait_for_report implements the
polling loop correctly once, so every caller does not implement it wrongly.

ZERO DEPENDENCIES. The standard library's urllib is the transport, and the
transport is injectable so the tests run with no network at all.
"""

from .client import (
    ApiError,
    QuorumClient,
    Result,
)

__all__ = ["ApiError", "QuorumClient", "Result"]
__version__ = "0.1.0"
