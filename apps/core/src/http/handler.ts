/**
 * API Gateway HTTP API (payload v2) → Fetch Request → Channels router.
 * Wired from sst.config.ts — no CloudFront / Next.js on AWS.
 */
import { dispatch } from "./router";

type ApiGatewayV2Event = {
  version?: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  requestContext: {
    domainName?: string;
    http: {
      method: string;
      path: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
  };
  body?: string | null;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string> | null;
};

type ApiGatewayV2Result = {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
};

function eventToRequest(event: ApiGatewayV2Event): Request {
  const domain = event.requestContext.domainName || "localhost";
  const proto =
    event.headers?.["x-forwarded-proto"] ||
    event.headers?.["X-Forwarded-Proto"] ||
    "https";
  const path = event.rawPath || event.requestContext.http.path || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${domain}${path}${qs}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers.set(key, value);
  }
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const method = event.requestContext.http.method.toUpperCase();
  const init: RequestInit = { method, headers };

  if (event.body && method !== "GET" && method !== "HEAD") {
    init.body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;
  }

  return new Request(url, init);
}

async function responseToResult(response: Response): Promise<ApiGatewayV2Result> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(value);
      return;
    }
    headers[key] = value;
  });

  const contentType = response.headers.get("content-type") || "";
  const isBinary =
    contentType.startsWith("image/") ||
    contentType.includes("octet-stream") ||
    contentType.includes("protobuf");

  if (isBinary) {
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      statusCode: response.status,
      headers,
      ...(cookies.length ? { cookies } : {}),
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  }

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: await response.text(),
    isBase64Encoded: false,
  };
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  try {
    const request = eventToRequest(event);
    const response = await dispatch(request);
    return responseToResult(response);
  } catch (err) {
    console.error("channels_api_unhandled", {
      error_type: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Something went wrong. Please retry." }),
    };
  }
}
