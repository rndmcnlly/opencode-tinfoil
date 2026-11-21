import assert from "node:assert/strict"
import { it } from "node:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { model, verifiedMiddleware } from "../src/provider.js"
import { TinfoilV2, V2_PACKAGE } from "../src/v2.js"

it("routes the native request and response through verified fetch only", async () => {
  const seen: unknown[] = []
  const middleware = verifiedMiddleware({
    fetch: async (input, init) => {
      seen.push([input, init])
      return new Response("verified", { status: 200 })
    },
  } as never)
  const request = HttpClientRequest.bodyText(
    HttpClientRequest.post("https://inference.tinfoil.sh/v1/chat/completions", {
      headers: { authorization: "Bearer fixture", "transfer-encoding": "chunked" },
    }),
    "private prompt",
  )
  const result = await Effect.runPromise(middleware(request))
  assert.equal(await Effect.runPromise(result.text), "verified")
  assert.equal(seen.length, 1)
  const [, init] = seen[0] as [unknown, RequestInit]
  assert.equal(init.body instanceof Uint8Array, true)
  assert.equal(request.headers["content-length"], "14")
  assert.equal(request.headers["transfer-encoding"], "chunked")
  const headers = new Headers(init.headers)
  assert.equal(headers.get("content-length"), null)
  assert.equal(headers.get("transfer-encoding"), null)
  assert.equal(headers.get("authorization"), "Bearer fixture")
  assert.equal(headers.get("content-type"), "text/plain")

  const failure = new Error("attestation rejected")
  const failing = verifiedMiddleware({ fetch: async () => { throw failure } } as never)
  await assert.rejects(Effect.runPromise(failing(request)), /attestation rejected/)
  await assert.rejects(
    Effect.runPromise(middleware(HttpClientRequest.post("https://inference.tinfoil.sh/v1/chat/completions"))),
    /unexpected inference body format/,
  )
  assert.equal(seen.length, 1)
})

it("refuses to construct a model with an absent or mismatched secure endpoint", () => {
  const baseURL = "https://inference.tinfoil.sh/v1/"
  assert.throws(() => model("sample", { baseURL }), /missing verified transport settings/)
  assert.throws(() => model("sample", {
    baseURL,
    tinfoil: { baseURL: "https://different.example/v1/", transport: "ehbp" },
  }), /baseURL must match/)
  const configured = model("sample", { baseURL, tinfoil: { baseURL, transport: "ehbp" } })
  assert.equal(configured.id, "sample")
  assert.equal(model("sample", { baseURL, tinfoil: { transport: "ehbp" } }).id, "sample")
})

it("upgrades marked models and removes unmarked or unsupported plaintext candidates", async () => {
  const providers = [
    { provider: { id: "tinfoil", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://inference.tinfoil.sh/v1/" } } },
    { provider: { id: "private", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://proxy.example/v1", apiKey: "secret", tinfoil: { attestationBundleURL: "https://proxy.example/attestation" } } } },
    { provider: { id: "safe", package: V2_PACKAGE, settings: { baseURL: "https://proxy.example/v1", tinfoil: { baseURL: "https://proxy.example/v1", transport: "ehbp" } } } },
    { provider: { id: "unsupported", package: "@opencode/ai/providers/anthropic", settings: { tinfoil: {} } } },
  ]
  const models = providers.map(({ provider }) => ({ providerID: provider.id, id: "model", package: provider.package }))
  const ctx = {
    options: {},
    model: {
      transform(callback: (editor: any) => void) {
        callback({
          provider: { list: () => providers },
          list: (id: string) => models.filter((model) => model.providerID === id),
          update: (providerID: string, id: string, update: (model: any) => void) => update(models.find((model) => model.providerID === providerID && model.id === id)!),
          remove: (providerID: string, id: string) => models.splice(models.findIndex((model) => model.providerID === providerID && model.id === id), 1),
        })
      },
    },
  }
  await TinfoilV2.setup(ctx as never)
  assert.deepEqual(models.map(({ providerID, package: name }) => [providerID, name]), [
    ["private", V2_PACKAGE], ["safe", V2_PACKAGE],
  ])
  assert.equal(providers[1].provider.settings.apiKey, "secret")
})
