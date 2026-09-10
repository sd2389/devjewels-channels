/** Web-standard JSON helpers (no next/server — safe for API Gateway Lambda). */

export function json(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(data, { status, headers });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Absolute URL only. Node/undici `Response.redirect()` throws TypeError on
 * relative paths (`/foo`), which API Gateway surfaces as HTTP 500.
 */
export function redirect(url: string | URL, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return Response.redirect(url, status);
}

/** Resolve a path against the incoming request so Location is always absolute. */
export function redirectTo(
  request: Request,
  path: string,
  status: 301 | 302 | 303 | 307 | 308 = 302,
): Response {
  return redirect(new URL(path, request.url), status);
}
