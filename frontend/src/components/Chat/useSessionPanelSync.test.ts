import { deepEqual, equal } from "node:assert/strict"
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

test("shouldScrollToBottom respects enabled gate and activity signals", () => {
  equal(
    shouldScrollToBottom({
      enabled: false,
      messageCount: 3,
      streamText: "streaming",
      toolCount: 1,
      busy: true,
    }),
    false,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "",
      toolCount: 0,
      busy: false,
    }),
    false,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "chunk",
      toolCount: 0,
    }),
    true,
  )
  equal(
    shouldScrollToBottom({
      messageCount: 0,
      streamText: "",
      toolCount: 0,
      busy: true,
    }),
    true,
  )
})
