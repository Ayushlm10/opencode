import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { model, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

const custom = {
  ...model("custom-model", ["high"]),
  providerID: "custom-provider",
  name: "Custom Model",
}
const free = { ...model("synthetic-free"), providerID: "opencode", name: "Free Synthetic" }
const location = { directory, project: { id: "project", directory, canonical: directory } }

test("catalog loss preserves the intended model and blocks submission until recovery or a deliberate switch", async () => {
  const record = session("ses_model_availability", { providerID: custom.providerID, id: custom.id, variant: "high" })
  let catalog = [custom, free]
  let modelRequests = 0
  const mutations: Array<{ type: "model" | "prompt"; body: unknown }> = []
  await using setup = await createAppFixture({
    args: { sessionID: record.id },
    config: { animations: false, keybinds: { "model.list": "f8" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider")
        return json({ location, data: [{ id: custom.providerID, name: "Example Provider" }, { id: "opencode", name: "OpenCode" }] })
      if (url.pathname === "/api/model") {
        modelRequests++
        return json({ location, data: catalog })
      }
      if (url.pathname === `/api/session/${record.id}`) return json({ data: record })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${record.id}/model`) {
        const body = await request.json()
        record.model = body.model
        mutations.push({ type: "model", body })
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/api/session/${record.id}/prompt`) {
        const body = await request.json()
        mutations.push({ type: "prompt", body })
        return json({
          data: {
            id: body.id,
            sessionID: record.id,
            type: "user",
            time: { created: 10 },
            payload: { text: body.text },
            delivery: "steer",
          },
        })
      }
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Custom Model") && frame.includes("high"))
  catalog = [free]
  const lostRequest = modelRequests + 1
  setup.events.emit({ id: "evt_catalog_lost", type: "model.updated", created: 1, location, data: {} })
  await setup.waitFor(() => modelRequests >= lostRequest)
  const unavailable = await setup.waitForFrame((frame) => frame.includes("custom-model (unavailable)"))
  expect(unavailable).not.toContain("Free Synthetic")

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Model unavailable"))
  expect(mutations).toEqual([])

  await setup.mockInput.typeText("SYNTHETIC_BLOCKED_PROMPT")
  setup.mockInput.pressEnter()
  await Bun.sleep(50)
  expect(mutations).toEqual([])
  expect(setup.captureCharFrame()).toContain("SYNTHETIC_BLOCKED_PROMPT")

  catalog = [custom, free]
  const recoveredRequest = modelRequests + 1
  setup.events.emit({ id: "evt_catalog_recovered", type: "model.updated", created: 2, location, data: {} })
  await setup.waitFor(() => modelRequests >= recoveredRequest)
  await setup.waitForFrame((frame) => frame.includes("Custom Model") && frame.includes("high"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => mutations.length === 2)
  expect(mutations).toEqual([
    { type: "model", body: { model: { providerID: custom.providerID, id: custom.id, variant: "high" } } },
    { type: "prompt", body: expect.objectContaining({ text: "SYNTHETIC_BLOCKED_PROMPT" }) },
  ])

  catalog = [free]
  const lostAgainRequest = modelRequests + 1
  setup.events.emit({ id: "evt_catalog_lost_again", type: "model.updated", created: 3, location, data: {} })
  await setup.waitFor(() => modelRequests >= lostAgainRequest)
  await setup.waitForFrame((frame) => frame.includes("custom-model (unavailable)"))
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame(
    (frame) => frame.includes("Select model") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Free Synthetic")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Free Synthetic") && !frame.includes("Select model"))
  await setup.mockInput.typeText("SYNTHETIC_DELIBERATE_SWITCH")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => mutations.length === 4)
  expect(mutations.slice(2)).toEqual([
    { type: "model", body: { model: { providerID: "opencode", id: "synthetic-free" } } },
    { type: "prompt", body: expect.objectContaining({ text: "SYNTHETIC_DELIBERATE_SWITCH" }) },
  ])
})
