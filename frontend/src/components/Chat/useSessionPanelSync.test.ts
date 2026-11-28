import { deepEqual, equal } from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import {
  clearAssistantTurns,
  getAssistantTurn,
  startAssistantTurn,
} from "./assistantTurnStore"
import {
  discardStaleTurn,
  resolveStorageSyncDecision,
  shouldScrollToBottom,
} from "./useSessionPanelSync"

test("resolveStorageSyncDecision ignores unrelated keys and empty storage in bot mode", () => {
  deepEqual(
    resolveStorageSyncDecision({
      storageKey: "bot:org-1:emp-1",
      eventKey: "other-key",
      newValue: "sess-2",
    }),
    { sync: false },
  )
  deepEqual(
    resolveStorageSyncDecision({
      storageKey: "bot:org-1:emp-1",
      eventKey: "bot:org-1:emp-1",
      newValue: "",
      syncEmptyStorage: false,
    }),
    { sync: false },
  )
  deepEqual(
    resolveStorageSyncDecision({
      storageKey: "bot:org-1:emp-1",
      eventKey: "bot:org-1:emp-1",
      newValue: "sess-2",
      syncEmptyStorage: false,
    }),
    { sync: true, sessionId: "sess-2", discardActiveTurn: false },
  )
})

test("resolveStorageSyncDecision handles empty resets and active-turn discarding in admin mode", () => {
  deepEqual(
    resolveStorageSyncDecision({
      storageKey: "admin:org-1",
      eventKey: "admin:org-1",
      newValue: "",
      activeTurnSessionId: "sess-1",
      syncEmptyStorage: true,
    }),
    { sync: true, sessionId: undefined, discardActiveTurn: true },
  )
  deepEqual(
    resolveStorageSyncDecision({
      storageKey: "admin:org-1",
      eventKey: "admin:org-1",
      newValue: "sess-1",
      activeTurnSessionId: "sess-1",
      syncEmptyStorage: true,
    }),
    { sync: true, sessionId: "sess-1", discardActiveTurn: false },
  )
})

test("discardStaleTurn discards mismatched active turn and keeps matching turn", () => {
  clearAssistantTurns()
  try {
    const key = "bot:org-1:emp-1"
    startAssistantTurn(key, "sess-1", {
      role: "user",
      payload: { text: "hello" },
      created_at: "2026-11-28T00:00:00Z",
    })
    discardStaleTurn(key, "sess-1")
    equal(getAssistantTurn(key)?.sessionId, "sess-1")

    discardStaleTurn(key, undefined)
    equal(getAssistantTurn(key)?.sessionId, "sess-1")

    discardStaleTurn(key, "sess-2")
    equal(getAssistantTurn(key), undefined)
  } finally {
    clearAssistantTurns()
  }
})

test("shouldScrollToBottom respects setupIntro gate, pendingMessage, and activity signals", () => {
  equal(
    shouldScrollToBottom({
      setupIntro: true,
      pendingMessage: undefined,
      messageCount: 3,
      streamText: "streaming",
      tools: [{ phase: "start", name: "t", ok: true }],
      busy: true,
    }),
    false,
  )
  equal(
    shouldScrollToBottom({
      setupIntro: true,
      pendingMessage: { role: "user", payload: { text: "continue" } },
      messageCount: 1,
      streamText: "",
      tools: [],
      busy: false,
    }),
    true,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "",
      tools: [],
      busy: false,
    }),
    false,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "chunk",
      tools: [],
    }),
    true,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "",
      tools: [],
      busy: true,
    }),
    true,
  )
})

test("admin first-turn attachment restoration retriggers scroll effect while busy and history stay unchanged", () => {
  const frontendDir = path.resolve(import.meta.dirname, "../../..")
  const script = `
    import { mock } from "bun:test"
    import { equal } from "node:assert/strict"
    let capturedDeps = []
    mock.module("react", () => ({
      useEffect: (_effect, deps) => { capturedDeps.push(deps) },
      useLayoutEffect: () => {},
      useRef: (current) => ({ current }),
    }))
    mock.module("@tanstack/react-router", () => ({
      useNavigate: () => () => {},
    }))
    const { useSessionPanelSync } = await import("./src/components/Chat/useSessionPanelSync.ts")
    const {
      clearAssistantTurns,
      getAssistantTurn,
      startAssistantTurn,
      updateAssistantTurn,
    } = await import("./src/components/Chat/assistantTurnStore.ts")
    clearAssistantTurns()
    try {
      const key = "admin:sample"
      const pending = {
        role: "user",
        payload: { text: "sample", attachments: [] },
        created_at: "2026-01-01T00:00:00Z",
      }
      const render = () => {
        capturedDeps = []
        const turn = getAssistantTurn(key)
        useSessionPanelSync({
          storageKey: key,
          mode: "admin",
          syncEmptyStorage: true,
          scroll: {
            messageCount: 0,
            streamText: turn.text,
            tools: turn.tools,
            busy: turn.status === "streaming",
            setupIntro: false,
            pendingMessage: turn.pendingUserMessage,
          },
        })
        return capturedDeps[1]
      }
      const controller = startAssistantTurn(key, undefined, pending)
      const before = render()
      updateAssistantTurn(key, controller, {
        sessionId: "s1",
        pendingUserMessage: {
          ...pending,
          payload: {
            ...pending.payload,
            attachments: [
              { id: "a1", filename: "sample.txt", kind: "document", size: 30 },
            ],
          },
        },
      })
      const after = render()
      equal(after.some((v, i) => !Object.is(v, before[i])), true)
    } finally {
      clearAssistantTurns()
    }
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: frontendDir,
    encoding: "utf8",
  })
  equal(result.status, 0, result.stderr || result.stdout)
})
