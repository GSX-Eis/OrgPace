import { equal } from "node:assert/strict"
import { test } from "node:test"
import { client } from "@/client/client.gen"
import i18n, { getLocale } from "@/i18n"
import { buildClientRequest } from "./clientRequest"

test("buildClientRequest uses shared client baseURL, auth token, and locale header", async () => {
  const previous = client.getConfig()
  client.setConfig({
    baseURL: "https://api.example.test",
    auth: () => "token-sync-123",
  })
  try {
    const req = await buildClientRequest(
      "/api/v1/bot/sessions/s1/turns?org_id=o1",
      { "Content-Type": "application/json" },
    )
    equal(
      req.url,
      "https://api.example.test/api/v1/bot/sessions/s1/turns?org_id=o1",
    )
    equal(req.headers.get("Authorization"), "Bearer token-sync-123")
    equal(req.headers.get("Accept-Language"), getLocale())
    equal(req.headers.get("Content-Type"), "application/json")
  } finally {
    client.setConfig(previous)
  }
})

test("buildClientRequest supports async auth, omits empty auth, and preserves caller overrides", async () => {
  const previous = client.getConfig()
  const previousLang = i18n.language
  try {
    await i18n.changeLanguage("en")
    client.setConfig({
      baseURL: "",
      auth: async () => "",
    })
    const unauthenticated = await buildClientRequest("/api/v1/test")
    equal(unauthenticated.url, "/api/v1/test")
    equal(unauthenticated.headers.get("Authorization"), null)
    equal(unauthenticated.headers.get("Accept-Language"), "en")

    client.setConfig({
      baseURL: "https://orgpace.test",
      auth: async () => "async-token-456",
    })
    const asyncReq = await buildClientRequest("/api/v1/test")
    equal(asyncReq.url, "https://orgpace.test/api/v1/test")
    equal(asyncReq.headers.get("Authorization"), "Bearer async-token-456")

    const custom = await buildClientRequest("/api/v1/test", {
      Authorization: "Bearer override",
      "Accept-Language": "zh-CN",
    })
    equal(custom.headers.get("Authorization"), "Bearer override")
    equal(custom.headers.get("Accept-Language"), "zh-CN")
  } finally {
    await i18n.changeLanguage(previousLang)
    client.setConfig(previous)
  }
})
