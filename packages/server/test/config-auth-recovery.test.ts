import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { HttpServer } from "effect/unstable/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live(
  "keeps command login reachable while a cold remote configuration is blocked",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-auth-")))
      let available = true
      const remote = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname === "/.well-known/opencode") {
                return Response.json({
                  auth: {
                    command: [process.execPath, "-e", "process.stdout.write('synthetic-token')"],
                    env: "TOKEN",
                  },
                  remote_config: {
                    url: `${url.origin}/config`,
                    headers: { authorization: "Bearer {env:TOKEN}" },
                  },
                })
              }
              if (
                url.pathname === "/config" &&
                available &&
                request.headers.get("authorization") === "Bearer synthetic-token"
              ) {
                return Response.json({
                  model: "synthetic/chat",
                  providers: {
                    synthetic: {
                      package: "native",
                      settings: { baseURL: "https://gateway.example/v1" },
                      models: { chat: {} },
                    },
                  },
                  experimental: {
                    policies: [
                      { action: "provider.use", resource: "*", effect: "deny" },
                      { action: "provider.use", resource: "synthetic", effect: "allow" },
                    ],
                  },
                })
              }
              return new Response("Unavailable", { status: 503 })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(false)),
      )
      const database = path.join(tmp.path, "opencode.db")

      yield* withServer(tmp.path, database, (server) =>
        Effect.gen(function* () {
          const added = yield* request(server, "/api/experimental/integration/wellknown", {
            method: "POST",
            body: JSON.stringify({ url: remote.url.origin }),
          })
          expect(added.status).toBe(204)
          const attempt = yield* connect(server, remote.url.origin)
          yield* complete(server, remote.url.origin, attempt)
          yield* eventuallyModel(server, "synthetic", "chat")
        }),
      )

      available = false
      yield* withServer(tmp.path, database, (server) =>
        Effect.gen(function* () {
          expect(yield* model(server)).toBeNull()
          const integrations = yield* json(server, "/api/integration")
          const entry = locatedArray(integrations).find((item) => item.id === remote.url.origin)
          expect(entry?.methods).toContainEqual({
            id: "login",
            type: "command",
            label: "Log in",
            command: [process.execPath, "-e", "process.stdout.write('synthetic-token')"],
          })

          yield* complete(server, remote.url.origin, yield* connect(server, remote.url.origin))
          expect(yield* model(server)).toBeNull()

          available = true
          yield* complete(server, remote.url.origin, yield* connect(server, remote.url.origin))
          yield* eventuallyModel(server, "synthetic", "chat")
        }),
      )
    }),
  { timeout: 30_000 },
)

function withServer<A, E, R>(directory: string, database: string, use: (server: Server) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: database },
      config: { directory },
      fs: { filewatcher: false },
      models: { fetch: false },
    }).pipe(
      Effect.map((server) => ({
        base: HttpServer.formatAddress(server.address),
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      })),
      Effect.flatMap(use),
    ),
  )
}

interface Server {
  readonly base: string
  readonly headers: { readonly authorization: string }
}

const request = Effect.fnUntraced(function* (server: Server, target: string, init?: RequestInit) {
  return yield* Effect.tryPromise({
    try: () =>
      fetch(new URL(target, server.base), {
        ...init,
        headers: { ...server.headers, "content-type": "application/json", ...init?.headers },
      }),
    catch: (cause) => new Error(`Request failed: ${target}`, { cause }),
  })
})

const json = Effect.fnUntraced(function* (server: Server, target: string, init?: RequestInit) {
  const response = yield* request(server, target, init)
  expect(response.status).toBe(200)
  return (yield* Effect.promise(() => response.json())) as unknown
})

const connect = Effect.fnUntraced(function* (server: Server, integrationID: string) {
  const body = locatedRecord(
    yield* json(server, `/api/integration/${encodeURIComponent(integrationID)}/connect/command`, {
      method: "POST",
      body: JSON.stringify({ methodID: "login" }),
    }),
  )
  if (typeof body.attemptID !== "string") return yield* Effect.die("Expected command attempt ID")
  return body.attemptID
})

const complete = Effect.fnUntraced(function* (server: Server, integrationID: string, attemptID: string) {
  const target = `/api/integration/${encodeURIComponent(integrationID)}/connect/command/${attemptID}`
  yield* json(server, target).pipe(
    Effect.map(locatedRecord),
    Effect.filterOrFail((status) => status.status === "complete"),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("3 seconds"),
  )
  expect((yield* request(server, target, { method: "DELETE" })).status).toBe(204)
})

const model = Effect.fnUntraced(function* (server: Server) {
  const value = located(yield* json(server, "/api/model/default"))
  if (value === null) return null
  if (!isRecord(value)) return yield* Effect.die("Expected model response")
  return value
})

const eventuallyModel = Effect.fnUntraced(function* (server: Server, providerID: string, modelID: string) {
  yield* model(server).pipe(
    Effect.filterOrFail((value) => value?.providerID === providerID && value.id === modelID),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("3 seconds"),
  )
})

function located(value: unknown) {
  if (!isRecord(value) || !("data" in value)) throw new Error("Expected located response")
  return value.data
}

function locatedRecord(value: unknown) {
  const data = located(value)
  if (!isRecord(data)) throw new Error("Expected located object response")
  return data
}

function locatedArray(value: unknown) {
  const data = located(value)
  if (!Array.isArray(data) || !data.every(isRecord)) throw new Error("Expected located array response")
  return data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
