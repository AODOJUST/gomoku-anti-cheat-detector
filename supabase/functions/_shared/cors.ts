// _shared/cors.ts -- CORS headers and preflight handling shared by every Edge Function.
// The extension calls the functions from a chrome-extension:// origin, so we allow any
// origin but still need to echo the headers the client asks for (apikey, authorization).

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Returns a 204 preflight response when the request is an OPTIONS preflight,
 * or null when the caller should continue handling the request.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}
