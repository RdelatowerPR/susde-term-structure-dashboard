import assert from "node:assert/strict";
import test from "node:test";
import {
  API_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  SECURITY_HEADERS,
  forwardedScheme,
  isTrustedLocalAdminRequest,
  safeRedirectPath,
} from "./security.js";

test("detects Cloudflare and forwarded HTTP without trusting malformed input", () => {
  assert.equal(forwardedScheme({ "x-forwarded-proto": "http, https" }), "http");
  assert.equal(forwardedScheme({ "cf-visitor": '{"scheme":"https"}' }), "https");
  assert.equal(forwardedScheme({ "cf-visitor": "not-json" }), null);
});
test("manual sync requires direct loopback plus the deliberate admin header", () => {
  const request = (remoteAddress: string, headers: Record<string, string> = {}) => ({
    headers,
    socket: { remoteAddress },
    get: (name: string) => headers[name.toLowerCase()],
  });

  assert.equal(isTrustedLocalAdminRequest(request("127.0.0.1", { "x-local-admin": "1" })), true);
  assert.equal(isTrustedLocalAdminRequest(request("127.0.0.1")), false);
  assert.equal(
    isTrustedLocalAdminRequest(
      request("127.0.0.1", { "cf-connecting-ip": "203.0.113.9", "x-local-admin": "1" }),
    ),
    false,
  );
  assert.equal(isTrustedLocalAdminRequest(request("192.168.1.50", { "x-local-admin": "1" })), false);
});

test("security policy prevents framing, third-party code, transformation, and open redirects", () => {
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /script-src 'self'/);
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(PUBLIC_CACHE_CONTROL, /no-transform/);
  assert.match(API_CACHE_CONTROL, /no-transform/);
  assert.equal(safeRedirectPath("/api/stats?x=1"), "/api/stats?x=1");
  assert.equal(safeRedirectPath("//evil.example/path"), "/");
});
