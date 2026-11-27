import type { Page } from "@playwright/test"

declare global {
  interface Window {
    reply: {
      emit: (event: object) => void
      finish: () => void
      aborted: boolean
    }
  }
}

export async function mockAssistantStream(
  page: Page,
  service: "bot" | "admin-assistant",
  events: object[] = [{ type: "text", text: "第一段" }],
) {
  await page.addInitScript(
    ({ service, events }) => {
      const original = window.fetch
      window.fetch = async (input, init) => {
        if (
          typeof input !== "string" ||
          !input.includes(`/${service}/sessions/`) ||
          !input.includes("/turns?")
        )
          return original(input, init)
        if (
          !new Headers(init?.headers)
            .get("Authorization")
            ?.startsWith("Bearer ")
        )
          throw new Error("Missing bearer token")
        return new Response(
          new ReadableStream({
            start(controller) {
              const reply = {
                emit(event: object) {
                  const bytes = new TextEncoder().encode(
                    `${JSON.stringify(event)}\n`,
                  )
                  // Split inside a Chinese character as well as between NDJSON lines.
                  const middle = bytes.indexOf(0xe7) + 1
                  controller.enqueue(bytes.slice(0, middle))
                  controller.enqueue(bytes.slice(middle))
                },
                finish: () => controller.close(),
                aborted: false,
              }
              window.reply = reply
              init?.signal?.addEventListener(
                "abort",
                () => {
                  reply.aborted = true
                  controller.error(new DOMException("Stopped", "AbortError"))
                },
                { once: true },
              )
              for (const event of events) reply.emit(event)
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        )
      }
    },
    { service, events },
  )
}
