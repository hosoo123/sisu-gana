import { NextRequest, NextResponse } from "next/server";

const HOST_SESSION_COOKIE = "sisu-host-auth";
const HOST_SESSION_MS = 12 * 60 * 60 * 1000;

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

async function signExpiry(expires: string, password: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(expires),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function validSession(token: string | undefined, password: string) {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator < 1) return false;

  const expires = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+$/.test(expires) || Number(expires) <= Date.now()) return false;

  return matchesPassword(signature, await signExpiry(expires, password));
}

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const hostPage =
    pathname === "/host" ||
    pathname.startsWith("/host/") ||
    ((pathname === "/" || pathname === "/index.html") &&
      searchParams.get("mode") === "host");

  if (!hostPage) return NextResponse.next();

  const expectedPassword = process.env.HOST_ACCESS_PASSWORD?.trim();
  if (!expectedPassword) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new Response("Host access is not configured.", { status: 503 });
  }

  if (
    await validSession(
      request.cookies.get(HOST_SESSION_COOKIE)?.value,
      expectedPassword,
    )
  ) {
    return NextResponse.next();
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
        const response = NextResponse.next();
        const expires = String(Date.now() + HOST_SESSION_MS);
        const signature = await signExpiry(expires, expectedPassword);
        response.cookies.set(HOST_SESSION_COOKIE, `${expires}.${signature}`, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          path: "/",
          maxAge: HOST_SESSION_MS / 1000,
        });
        return response;
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
