import { NextRequest, NextResponse } from "next/server";

async function matchesPassword(candidate: string, expected: string) {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;

  for (let index = 0; index < candidateBytes.length; index++) {
    difference |= candidateBytes[index] ^ expectedBytes[index];
  }

  return difference === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const hostPage =
    pathname === "/host" ||
    pathname.startsWith("/host/") ||
    ((pathname === "/" || pathname === "/index.html") &&
      searchParams.get("mode") === "host");

  if (!hostPage) return NextResponse.next();

  const expectedPassword = process.env.HOST_ACCESS_PASSWORD;
  if (!expectedPassword) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new Response("Host access is not configured.", { status: 503 });
  }

  const authorization = request.headers.get("authorization") || "";
  const [scheme, encoded] = authorization.split(" ", 2);
  if (scheme === "Basic" && encoded) {
    try {
      const credentials = atob(encoded);
      const separator = credentials.indexOf(":");
      const username = credentials.slice(0, separator);
      const password = credentials.slice(separator + 1);

      if (
        separator >= 0 &&
        username === "host" &&
        (await matchesPassword(password, expectedPassword))
      ) {
        return NextResponse.next();
      }
    } catch {
      // Invalid Basic credentials are handled by the challenge below.
    }
  }

  return new Response("Host access required.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="SISU Quiz Host", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/host/:path*", "/", "/index.html"],
};
