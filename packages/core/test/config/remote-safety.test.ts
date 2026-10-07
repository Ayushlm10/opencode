import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigPolicyPlugin } from "@opencode/core/config/plugin/policy"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Global } from "@opencode/util/global"
import { Integration } from "@opencode/schema/integration"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { WellKnown } from "@opencode/core/wellknown"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

it.live("preserves the last complete provider policy and endpoint through a warm remote failure", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
    const project = path.join(tmp.path, "project")
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => Promise.all([fs.mkdir(project), fs.mkdir(global)]))
    const bus = yield* Bus.Service
    const catalog = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin)
    const remoteID = Provider.ID.make("synthetic")
    yield* catalog.transform((providers) => {
      providers.update(Provider.ID.opencode, (provider) => {
        provider.settings = { baseURL: "https://free.example/v1" }
      })
    })

    const integrationID = Integration.ID.make("https://config.example")
    const credentialID = Credential.ID.create()
    let available = true
    let endpoint = "https://gateway.example/v1"
    const credentialNode = makeGlobalNode({
      service: Credential.Service,
      layer: Layer.mock(Credential.Service)({
        list: () =>
          Effect.succeed([
            new Credential.Info({
              id: credentialID,
              integrationID,
              label: "synthetic",
              value: Credential.Key.make({ type: "key", key: "synthetic-token" }),
            }),
          ]),
      }),
      deps: [],
    })
    let entry: WellKnown.Entry = {
      origin: integrationID,
      integrationID,
      manifest: { auth: { command: ["synthetic-login"], env: "TOKEN" } },
    }
    const wellknownNode = makeGlobalNode({
      service: WellKnown.Service,
      layer: Layer.mock(WellKnown.Service)({
        entries: () => Effect.succeed([entry]),
        snapshot: () => [entry],
        refresh: () => Effect.succeed(false),
        resolve: (_entry, variables) => {
          expect(variables.TOKEN).toBe("synthetic-token")
          return available
            ? Effect.succeed([
                {
                  model: "synthetic/chat",
                  providers: {
                    synthetic: {
                      package: "native",
                      settings: { baseURL: endpoint },
                      models: { chat: {} },
                    },
                  },
                  experimental: {
                    policies: [
                      { action: "provider.use", resource: "*", effect: "deny" },
                      { action: "provider.use", resource: "synthetic", effect: "allow" },
                    ],
                  },
                },
              ])
            : Effect.fail(new Error("remote unavailable"))
        },
      }),
      deps: [],
    })
    const configLayer = AppNodeBuilder.build(LayerNode.group([Config.node]), [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
      ),
      Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
      Bus.node.replace(Layer.succeed(Bus.Service, bus)),
      Credential.node.replace(credentialNode),
      WellKnown.node.replace(wellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ])

    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      yield* ConfigProviderPlugin.Plugin.effect(host)
      yield* ConfigPolicyPlugin.Plugin.effect(host)
      const snapshot = Effect.fnUntraced(function* () {
        const entries = yield* config.entries()
        return {
          entries,
          model: Config.latest(entries, "model"),
          policies: entries.flatMap((item) =>
            item.type === "document" ? (item.info.experimental?.policies ?? []) : [],
          ),
          free: yield* catalog.get(Provider.ID.opencode),
          remote: yield* catalog.get(remoteID),
        }
      })
      const reload = Effect.fnUntraced(function* () {
        yield* bus.publish(Credential.Event.Switched, { credentialID, integrationID }, { global: true })
        yield* Effect.sleep("150 millis")
      })

      const loaded = yield* snapshot()
      expect(loaded.free).toBeUndefined()
      expect(loaded.remote?.settings?.baseURL).toBe("https://gateway.example/v1")

      entry = { ...entry, manifest: {} }
      yield* bus.publish(WellKnown.Event.Updated, {})
      yield* Effect.sleep("150 millis")
      const missingAuth = yield* snapshot()
      expect(missingAuth.model).toEqual(loaded.model)
      expect(missingAuth.policies).toEqual(loaded.policies)
      expect(missingAuth.free).toBeUndefined()
      expect(missingAuth.remote?.settings?.baseURL).toBe("https://gateway.example/v1")

      entry = {
        ...entry,
        manifest: { auth: { command: ["synthetic-login"], env: "TOKEN" } },
      }
      available = false
      yield* reload()
      const failed = yield* snapshot()
      expect(failed.model).toEqual(loaded.model)
      expect(failed.policies).toEqual(loaded.policies)
      expect(failed.entries).toEqual(loaded.entries)
      expect(failed.free).toBeUndefined()
      expect(failed.remote?.settings?.baseURL).toBe("https://gateway.example/v1")

      available = true
      endpoint = "https://gateway.example/v2"
      yield* reload()
      const recovered = yield* snapshot()
      expect(recovered.free).toBeUndefined()
      expect(recovered.remote?.settings?.baseURL).toBe("https://gateway.example/v2")
    }).pipe(
      Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
      Effect.provide(configLayer),
    )
  }),
)
