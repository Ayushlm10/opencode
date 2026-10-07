import { expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KV } from "@opencode/core/kv"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { WellKnown } from "@opencode/core/wellknown"
import { WellKnownPlugin } from "@opencode/core/wellknown/plugin"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginTestLayer } from "./plugin/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(FetchHttpClient.layer)
const serviceIt = testEffect(LayerNode.compile(LayerNode.group([WellKnown.node, KV.node, Bus.node])))
const pluginIt = testEffect(PluginTestLayer)

pluginIt.live("keeps known login methods and refresh listeners after initial discovery fails", () =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const integrations = yield* Integration.Service
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin)
    const integrationID = Integration.ID.make("https://login.example")
    let entry: WellKnown.Entry = {
      origin: integrationID,
      integrationID,
      manifest: { auth: { command: ["synthetic-login"], env: "TOKEN" } },
    }
    const wellknown = WellKnown.Service.of({
      entries: () => Effect.fail(new Error("discovery unavailable")),
      snapshot: () => [entry],
      refresh: () => Effect.succeed(false),
      add: () => Effect.die("unused WellKnown.add"),
      remove: () => Effect.die("unused WellKnown.remove"),
      resolve: () => Effect.die("unused WellKnown.resolve"),
    })

    yield* WellKnownPlugin.Plugin.effect(host).pipe(Effect.provideService(WellKnown.Service, wellknown))
    expect((yield* integrations.get(integrationID))?.methods).toContainEqual({
      id: Integration.MethodID.make("login"),
      type: "command",
      label: "Log in",
      command: ["synthetic-login"],
    })

    entry = { ...entry, manifest: { auth: { command: ["recovered-login"], env: "TOKEN" } } }
    yield* bus.publish(WellKnown.Event.Updated, {})
    yield* waitUntil(
      integrations
        .get(integrationID)
        .pipe(
          Effect.map(
            (value) =>
              value?.methods.some((method) => method.type === "command" && method.command[0] === "recovered-login") ===
              true,
          ),
        ),
    )
  }),
)

it.live("loads embedded and remote configuration", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/opencode") {
            return Response.json({
              auth: { command: ["login"], env: "TOKEN" },
              config: { model: "embedded/model" },
              remote_config: {
                url: `${url.origin}/config/{env:TOKEN}`,
                headers: { authorization: "Bearer {env:TOKEN}" },
              },
            })
          }
          if (url.pathname === "/config/secret" && request.headers.get("authorization") === "Bearer secret") {
            return Response.json({ config: { model: "remote/model" } })
          }
          return new Response("Not found", { status: 404 })
        },
      }),
    ),
    (server) =>
      Effect.gen(function* () {
        const origin = server.url.origin
        expect(yield* WellKnown.inspect(`${origin}/`)).toEqual({
          auth: { command: ["login"], env: "TOKEN" },
          config: { model: "embedded/model" },
          remote_config: {
            url: `${origin}/config/{env:TOKEN}`,
            headers: { authorization: "Bearer {env:TOKEN}" },
          },
        })
        expect(yield* WellKnown.resolve({ origin, variables: { TOKEN: "secret" } })).toEqual([
          { model: "embedded/model" },
          { model: "remote/model" },
        ])
      }),
    (server) => Effect.promise(() => server.stop(true)),
  ),
)

serviceIt.live("persists sources in one KV value", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch: () => Response.json({ auth: { command: ["login"], env: "TOKEN" } }),
      }),
    ),
    (server) =>
      Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const kv = yield* KV.Service
        const bus = yield* Bus.Service
        const changed = yield* bus
          .subscribe(WellKnown.Event.Updated)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
        const entry = yield* wellknown.add(`${server.url.origin}/`)

        expect(entry.origin).toBe(server.url.origin)
        expect(yield* kv.get("wellknown:sources")).toEqual([server.url.origin])
        expect(yield* wellknown.entries()).toEqual([entry])
        expect(yield* Fiber.join(changed)).toHaveLength(1)

        yield* wellknown.remove(server.url.origin)
        expect(yield* kv.get("wellknown:sources")).toEqual([])
        expect(yield* wellknown.entries()).toEqual([])
      }),
    (server) => Effect.promise(() => server.stop(true)),
  ),
)

serviceIt.live("refreshes changed manifests", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let command = "first"
      return {
        server: Bun.serve({
          port: 0,
          fetch: () => Response.json({ auth: { command: [command], env: "TOKEN" } }),
        }),
        update: () => {
          command = "second"
        },
      }
    }),
    ({ server, update }) =>
      Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const bus = yield* Bus.Service
        yield* wellknown.add(server.url.origin)
        expect(yield* wellknown.refresh()).toBe(false)

        const changed = yield* bus
          .subscribe(WellKnown.Event.Updated)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
        update()
        expect(yield* wellknown.refresh()).toBe(true)
        expect(yield* Fiber.join(changed)).toHaveLength(1)
        expect(wellknown.snapshot()[0]?.manifest.auth?.command).toEqual(["second"])
      }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ),
)

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for wellknown reload")
})
