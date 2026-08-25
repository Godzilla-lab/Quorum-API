# quorum-api (Python)

The typed Python client for the Quorum market evidence API. Written against
`spec/openapi.yaml`, which is the contract. Standard library only: no
dependencies, and the transport is injectable so the tests run with no
network at all.

Errors are values, never raised. Retry-After is honoured, and
`wait_for_report` implements the polling loop correctly once so every caller
does not implement it wrongly.

```python
from quorum_api import QuorumClient

client = QuorumClient("https://quorum-api-j15n.onrender.com", api_key="qk_...")

accepted = client.create_report("running shoes", terms=["sizing"])
if accepted.ok:
    report = client.wait_for_report(accepted.data["id"])
    if report.ok:
        for finding in report.data["findings"]:
            print(finding["term"], finding["records"], "records")

# Every receipt id resolves back to the real record behind it.
record = client.get_evidence("rc_4d6d444821b0044f")
```

Not yet published to PyPI. Install from the repo:

```bash
pip install packages/sdk-py
```

Tests: `python3 -m unittest discover -s packages/sdk-py/tests`
