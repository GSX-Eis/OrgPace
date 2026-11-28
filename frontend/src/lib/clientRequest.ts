import { client } from "@/client/client.gen"
import { getAuthToken } from "@/client/core/auth.gen"
import { getLocale } from "@/i18n"

/** Build URL and headers from the shared OpenAPI client config for fetch-based requests. */
export async function buildClientRequest(
  url: string,
  headersInit?: HeadersInit,
): Promise<{ url: string; headers: Headers }> {
  const { auth } = client.getConfig()
  const headers = new Headers(headersInit)
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", getLocale())
  }
  if (!headers.has("Authorization") && auth) {
    const authorization = await getAuthToken(
      { scheme: "bearer", type: "http" },
      auth,
    )
    if (authorization) headers.set("Authorization", authorization)
  }
  return {
    url: client.buildUrl({ url }),
    headers,
  }
}
