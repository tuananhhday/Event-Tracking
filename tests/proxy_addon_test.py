"""Addon behavior tests do not import mitmproxy or issue any network request."""
import importlib.util
import json
import tempfile
import unittest
import re
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("eventqa_addon", Path(__file__).resolve().parents[1] / "proxy" / "mitm_addon.py")
addon_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon_module)


class AddonTests(unittest.TestCase):
    def test_default_and_extra_endpoints_match_host_path_only(self):
        patterns = [re.compile(pattern, re.I) for pattern in addon_module.DEFAULT_PATTERNS]
        self.assertTrue(addon_module.matches_endpoint("https://www.google-analytics.com/g/collect?en=search_submit", patterns))
        self.assertTrue(addon_module.matches_endpoint("https://analytics.google.com/g/collect", patterns))
        self.assertTrue(addon_module.matches_endpoint("https://api.useinsider.com/events", patterns))
        self.assertFalse(addon_module.matches_endpoint("https://example.com/business?next=www.google-analytics.com/g/collect", patterns))
        extra = patterns + [re.compile(r"^tracking\.example\.com/events$"), re.compile(r"/demo/g/collect")]
        self.assertTrue(addon_module.matches_endpoint("https://tracking.example.com/events?token=secret", extra))
        self.assertTrue(addon_module.matches_endpoint("http://127.0.0.1:4173/demo/g/collect", extra))
        self.assertFalse(addon_module.matches_endpoint("https://tracking.example.com/events/other", extra))

    def test_identifiers_and_json_secret_strings_are_redacted(self):
        identifiers = {key: "private-identifier" for key in ["sid", "vid", "device_id", "visitor_id", "client_id", "uid"]}
        sanitized = addon_module.redact(identifiers)
        self.assertNotIn("private-identifier", json.dumps(sanitized))
        self.assertNotIn("secret-value", addon_module.redact_string('dataLayer.push({"access_token":"secret-value"})'))

    def test_json_and_form_redaction(self):
        for raw, content_type in [
            (json.dumps({"event": "purchase", "email": "private@example.com", "nested": {"access_token": "secret"}}), "application/json"),
            ("en=purchase&ep.email=private%40example.com&access_token=secret", "application/x-www-form-urlencoded"),
        ]:
            body, reason = addon_module.safe_body(raw, content_type)
            self.assertIsNone(reason)
            self.assertNotIn("private", body)
            self.assertNotIn("secret", body)
            self.assertIn("purchase", body)

    def test_nested_url_credentials_are_redacted(self):
        value = addon_module.redact_url("https://www.google-analytics.com/g/collect?en=login&dl=https%3A%2F%2Fexample.com%2F%3Ftoken%3Dsecret&email=private%40example.com")
        self.assertNotIn("secret", value)
        self.assertNotIn("private", value)
        self.assertIn("login", value)

    def test_opaque_payload_not_saved(self):
        body, reason = addon_module.safe_body("opaque-secret-binary", "application/protobuf")
        self.assertEqual(body, "")
        self.assertEqual(reason, "unsupported_format")

    def test_capture_lifecycle_does_not_mutate_business_request(self):
        with tempfile.TemporaryDirectory(prefix="eventqa-addon-") as temp:
            addon = addon_module.EventQAAddon()
            addon.output = Path(temp) / "events.jsonl"
            payload = json.dumps({"event": "search_submit", "email": "private@example.com", "service": "hotel"})
            request = SimpleNamespace(pretty_url="https://www.google-analytics.com/g/collect?access_token=secret", method="POST", raw_content=payload.encode(), headers={"content-type": "application/json", "referer": "https://hotel.example/search?token=secret"}, timestamp_start=1793269800, get_text=lambda strict=False: payload)
            flow = SimpleNamespace(id="R1", metadata={}, request=request, response=SimpleNamespace(status_code=204))
            addon.request(flow)
            addon.response(flow)
            addon.error(flow)
            lines = addon.output.read_text(encoding="utf-8").splitlines()
            records = [json.loads(line) for line in lines]
            self.assertEqual([record["phase"] for record in records], ["request", "response", "failed"])
            self.assertEqual(records[0]["request_id"], records[1]["request_id"])
            self.assertTrue(records[0]["page_url"].startswith("https://hotel.example/search"))
            self.assertNotIn("private", "\n".join(lines))
            self.assertNotIn("secret", "\n".join(lines))
            self.assertEqual(request.raw_content, payload.encode())
            self.assertIn("access_token=secret", request.pretty_url)

    def test_non_tracking_business_requests_are_ignored(self):
        with tempfile.TemporaryDirectory(prefix="eventqa-ignore-") as temp:
            addon = addon_module.EventQAAddon()
            addon.output = Path(temp) / "events.jsonl"
            flow = SimpleNamespace(metadata={}, request=SimpleNamespace(pretty_url="https://example.com/checkout"))
            addon.request(flow)
            self.assertFalse(addon.output.exists())
            self.assertFalse(flow.metadata)


if __name__ == "__main__":
    unittest.main()
