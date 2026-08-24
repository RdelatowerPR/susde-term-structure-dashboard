import type { Express, NextFunction, Request, Response } from "express";

type HeaderValue = string | string[] | undefined;
type HeaderMap = Record<string, HeaderValue>;

export const PUBLIC_CACHE_CONTROL = "public, max-age=300, no-transform";
export const API_CACHE_CONTROL = "no-store, no-transform";

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "browsing-topics=(), camera=(), geolocation=(), interest-cohort=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
} as const);

function firstHeader(value: HeaderValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
export function forwardedScheme(headers: HeaderMap): string | null {
  const xForwardedProto = firstHeader(headers["x-forwarded-proto"])
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  if (xForwardedProto === "http" || xForwardedProto === "https") return xForwardedProto;

  const cfVisitor = firstHeader(headers["cf-visitor"]);
  if (!cfVisitor) return null;
  try {
    const scheme = String((JSON.parse(cfVisitor) as { scheme?: unknown }).scheme ?? "").toLowerCase();
    return scheme === "http" || scheme === "https" ? scheme : null;
  } catch {
    return null;
  }
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isTrustedLocalAdminRequest(req: Pick<Request, "get" | "headers" | "socket">): boolean {
  const cameThroughProxy = ["cf-connecting-ip", "cf-ray", "forwarded", "x-forwarded-for"].some(
    (name) => Boolean(firstHeader(req.headers[name])),
  );
  return (
    isLoopbackAddress(req.socket.remoteAddress) &&
    !cameThroughProxy &&
    req.get("x-local-admin") === "1"
  );
}

export function safeRedirectPath(originalUrl: string): string {
  return originalUrl.startsWith("/") && !originalUrl.startsWith("//") ? originalUrl : "/";
}

export function installPublicSecurity(app: Express, publicOrigin: string): void {
  app.disable("x-powered-by");
  app.use((req: Request, res: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.setHeader("Cache-Control", req.path.startsWith("/api/") ? API_CACHE_CONTROL : PUBLIC_CACHE_CONTROL);

    if (forwardedScheme(req.headers) === "http") {
      res.redirect(308, `${publicOrigin}${safeRedirectPath(req.originalUrl)}`);
      return;
    }
    next();
  });
}
