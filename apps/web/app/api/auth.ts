/**
 * Basic authentication helper for API routes.
 * 
 * This checks for a bearer token in the Authorization header.
 * The token should match the POKE_API_TOKEN environment variable.
 * 
 * If POKE_API_TOKEN is not set, all requests are allowed (local development mode).
 */
export function checkAuth(request: Request): Response | null {
  const token = process.env.POKE_API_TOKEN;
  
  // If no token is configured, allow all requests (local/private deployment)
  if (!token) {
    return null;
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
