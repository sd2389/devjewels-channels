/** Web-standard JSON helpers (no next/server — safe for API Gateway Lambda). */

export function json(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(data, { status, headers });
}

export function redirect(url: string | URL, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return Response.redirect(url, status);
}
