/**
 * Basic authentication helper for API routes.
 *
 * This checks for a bearer token in the Authorization header.
 * The token should match the POKE_API_TOKEN environment variable.
 *
 * If no token is configured, access is denied unless an explicit development bypass is enabled.
 */
export function checkAuth(request: Request): Response | null {
  const token = process.env.POKE_API_TOKEN?.trim();
  const devBypassEnabled = process.env.POKE_API_DEV_BYPASS === "true" && process.env.NODE_ENV !== "production";

  if (!token) {
    if (devBypassEnabled) {
      return null;
    }
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  const authHeader = request.headers.get("authorization");
  const providedToken = authHeader?.replace(/^Bearer\s+/i, "");

  if (!providedToken || providedToken !== token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  return null;
}
