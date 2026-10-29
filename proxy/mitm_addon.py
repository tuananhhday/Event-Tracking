"""EventQA read-only mitmproxy addon: redacts before JSONL persistence, never replays.

Loaded with mitmdump -s. Output and endpoint allowlist are supplied by Node adapter.
No flow dump is written and no certificate is installed by this addon.
"""
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SENSITIVE = re.compile(r"(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session[_-]?(?:id|token)|visitor[_-]?id|device[_-]?id|email|phone|mobile|telephone|full[_-]?name|first[_-]?name|last[_-]?name|address|credit[_-]?card|card[_-]?number|cvv|user[_-]?id|client[_-]?id|(?:^|[._-])(?:uid|cid|sid|vid|_ga|gclid|fbclid)(?:$|[._-]))", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
PHONE = re.compile(r"(?<!\w)(?:\+?84|0)[\s.-]?(?:\d[\s.-]?){8,10}(?!\w)")
TEXT_SECRET = re.compile(r'''((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie)["']?\s*[=:]\s*["']?)([^\s&,;"'}]+)''', re.I)
DEFAULT_PATTERNS = [r"google-analytics\.com/(?:g/)?collect", r"analytics\.google\.com/(?:g/)?collect", r"(?:^|\.)useinsider\.com/", r"(?:^|\.)api\.useinsider\.com/"]


def redact_string(value):
    value = TEXT_SECRET.sub(r"\1[REDACTED]", value)
    value = BEARER.sub("Bearer [REDACTED]", value)
    value = JWT.sub("[REDACTED]", value)
    value = EMAIL.sub("[REDACTED]", value)
    return PHONE.sub("[REDACTED]", value)


# Same rule as STATIC_ASSET in src/core/decoder.mjs.
STATIC_ASSET = re.compile(r"\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|woff2?|ttf|map)$", re.I)


def matches_endpoint(url, patterns):
    try:
        parsed = urlsplit(url)
        subject = (parsed.hostname or "") + parsed.path
        return not STATIC_ASSET.search(parsed.path) and any(pattern.search(subject) for pattern in patterns)
    except (TypeError, ValueError):
        return False


def redact(value):
    if isinstance(value, dict):
        return {str(key): "[REDACTED]" if SENSITIVE.search(str(key)) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        if value.startswith(("http://", "https://")):
            return redact_url(value)
        return redact_string(value)
    return value


def redact_url(value):
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        if parts.port:
            host += ":" + str(parts.port)
        query = [(key, "[REDACTED]" if SENSITIVE.search(key) else redact(item)) for key, item in parse_qsl(parts.query, keep_blank_values=True)]
        return urlunsplit((parts.scheme, host, redact_string(parts.path), urlencode(query), ""))
    except (ValueError, TypeError):
        return "[INVALID_URL]"


def safe_body(raw, content_type):
    """Do not persist opaque/unparsed text: its secrets cannot be safely classified."""
    if not raw:
        return "", None
    try:
        parsed = json.loads(raw)
        return json.dumps(redact(parsed), ensure_ascii=False), None
    except (ValueError, TypeError):
        pass
    lines = raw.splitlines()
    if len(lines) > 1:
        try:
            parsed = [json.loads(line) for line in lines if line.strip()]
            return "\n".join(json.dumps(redact(item), ensure_ascii=False) for item in parsed), None
        except (ValueError, TypeError):
            pass
    if "application/x-www-form-urlencoded" in content_type or ("=" in raw and all("=" in line for line in lines if line.strip())):
        output = []
        for line in lines:
            pairs = parse_qsl(line, keep_blank_values=True)
            output.append(urlencode([(key, "[REDACTED]" if SENSITIVE.search(key) else redact(item)) for key, item in pairs]))
        return "\n".join(output), None
    return "", "unsupported_format"


class EventQAAddon:
    def __init__(self):
        self.patterns = [re.compile(pattern, re.I) for pattern in json.loads(os.environ.get("EVENTQA_ENDPOINT_PATTERNS", json.dumps(DEFAULT_PATTERNS)))]
        self.output = Path(os.environ.get("EVENTQA_PROXY_OUTPUT", "runs/proxy_events.jsonl")).resolve()

    def write(self, record):
        self.output.parent.mkdir(parents=True, exist_ok=True)
        with self.output.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(redact(record), ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def request(self, flow):
        if not matches_endpoint(flow.request.pretty_url, self.patterns):
            return
        flow.metadata["eventqa_captured"] = True
        raw_bytes = flow.request.raw_content or b""
        content_type = flow.request.headers.get("content-type", "")
        body, reason = safe_body(flow.request.get_text(strict=False) or "", content_type.lower())
        self.write({
            "phase": "request", "request_id": str(flow.id),
            "captured_at": datetime.fromtimestamp(flow.request.timestamp_start, timezone.utc).isoformat(),
            "url": redact_url(flow.request.pretty_url), "method": flow.request.method,
            "page_url": redact_url(flow.request.headers.get("referer", "")) if flow.request.headers.get("referer") else "",
            "content_type": content_type, "body": body,
            "raw_hash": hashlib.sha256(raw_bytes).hexdigest(),
            **({"decode_status": "UNPARSED", "reason": reason} if reason else {}),
        })

    def response(self, flow):
        if not flow.metadata.get("eventqa_captured"):
            return
        self.write({"phase": "response", "request_id": str(flow.id), "url": redact_url(flow.request.pretty_url), "status": flow.response.status_code})

    def error(self, flow):
        if not flow.metadata.get("eventqa_captured"):
            return
        # Free-form error text may include credentials; retain a stable diagnostic code only.
        self.write({"phase": "failed", "request_id": str(flow.id), "url": redact_url(flow.request.pretty_url), "error": "PROXY_UPSTREAM_ERROR"})


addons = [EventQAAddon()]
