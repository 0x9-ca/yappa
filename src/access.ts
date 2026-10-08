import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksDomain: string | undefined;

/**
 * Verifies the Cloudflare Access JWT on the request against the existing
 * Access application's AUD. Returns the authenticated email, or null.
 */
export async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  if (!jwks || jwksDomain !== teamDomain) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksDomain = teamDomain;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
    });
    return typeof payload.email === "string" ? payload.email : (payload.sub ?? null);
  } catch {
    return null;
  }
}
