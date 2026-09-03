import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import {
  createTinfoilPlugin,
  type TinfoilSecureClientOptions,
} from "../src/index.js"

const input = {} as PluginInput

const options = {
  providerID: "private-inference",
  name: "Private Inference",
  apiKey: "test-key",
  baseURL: "https://proxy.example/v1/",
  attestationBundleURL: "https://proxy.example/attestation",
  models: {
    "example-model": {
      name: "Example Model",
      limit: { context: 128_000, output: 16_000 },
    },
  },
}

async function configuredProvider(
  factory: (secureOptions: TinfoilSecureClientOptions) => { fetch: typeof fetch },
  pluginOptions: Record<string, unknown> = options,
) {
  const plugin = createTinfoilPlugin(factory)
  const hooks = await plugin(input, pluginOptions)
  const config = {} as Config
  await hooks.config!(config)
  return config.provider!["private-inference"] as any
}

describe("opencode-tinfoil", () => {
  it("defaults to the direct Tinfoil service and OpenCode-managed auth", async () => {
    const plugin = createTinfoilPlugin(() => ({ fetch }))
    const hooks = await plugin(input)
    const config = {} as Config
    await hooks.config!(config)
    const provider = config.provider!.tinfoil as any

    assert.equal(provider.name, "Tinfoil")
    assert.equal(provider.options.apiKey, undefined)
    assert.equal(provider.options.baseURL, "https://inference.tinfoil.sh/v1/")
    assert.equal(provider.models, undefined)
  })

  it("can upgrade marked providers without creating the default provider", async () => {
    const created: TinfoilSecureClientOptions[] = []
    const plugin = createTinfoilPlugin((secureOptions) => {
      created.push(secureOptions)
      return { fetch: async () => new Response("encrypted response") }
    })
    const hooks = await plugin(input, { defaultProvider: false })
    const config = {
      provider: {
        "bayleaf-sealed-remote": {
          npm: "@ai-sdk/openai-compatible",
          name: "BayLeaf Sealed Remote",
          options: {
            baseURL: "https://api.example/sealed/v1/",
            apiKey: "bayleaf-key",
            tinfoil: {
              attestationBundleURL: "https://api.example/sealed",
              transport: "ehbp",
            },
          },
          models: { "example-model": { name: "Example Model" } },
        },
      },
    } as Config
    await hooks.config!(config)

    const provider = config.provider!["bayleaf-sealed-remote"] as any
    assert.equal(config.provider!.tinfoil, undefined)
    assert.equal(provider.options.apiKey, "bayleaf-key")
    assert.equal(provider.options.tinfoil, undefined)
    assert.equal(provider.options.includeUsage, true)
    assert.equal(created.length, 0)

    await provider.options.fetch("https://api.example/sealed/v1/chat/completions")
    assert.deepEqual(created, [{
      baseURL: "https://api.example/sealed/v1/",
      attestationBundleURL: "https://api.example/sealed",
      enclaveURL: undefined,
      configRepo: undefined,
      transport: "ehbp",
      userCacheSecret: undefined,
    }])
  })

  it("adds an OpenCode provider backed by the bundled compatible adapter", async () => {
    const provider = await configuredProvider(() => ({ fetch }))

    assert.equal(provider.npm, "@ai-sdk/openai-compatible")
    assert.equal(provider.name, "Private Inference")
    assert.equal(provider.options.apiKey, "test-key")
    assert.equal(provider.options.baseURL, "https://proxy.example/v1/")
    assert.equal(provider.options.includeUsage, true)
    assert.deepEqual(provider.models, options.models)
  })

  it("constructs one SecureClient lazily on the first request", async () => {
    const created: TinfoilSecureClientOptions[] = []
    const requested: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const provider = await configuredProvider((secureOptions) => {
      created.push(secureOptions)
      return {
        fetch: async (request, init) => {
          requested.push([request, init])
          return new Response("encrypted response")
        },
      }
    })

    assert.equal(created.length, 0)
    const first = await provider.options.fetch("https://proxy.example/v1/chat/completions", {
      method: "POST",
      body: "sensitive body",
    })
    await provider.options.fetch("https://proxy.example/v1/responses", { method: "POST" })

    assert.equal(await first.text(), "encrypted response")
    assert.equal(created.length, 1)
    assert.deepEqual(created[0], {
      baseURL: "https://proxy.example/v1/",
      attestationBundleURL: "https://proxy.example/attestation",
      enclaveURL: undefined,
      configRepo: undefined,
      transport: "ehbp",
      userCacheSecret: undefined,
    })
    assert.equal(requested.length, 2)
  })

  it("propagates secure transport failures without a plaintext fallback", async () => {
    const failure = new Error("attestation rejected")
    const provider = await configuredProvider(() => ({
      fetch: async () => {
        throw failure
      },
    }))

    await assert.rejects(
      provider.options.fetch("https://proxy.example/v1/chat/completions", {
        method: "POST",
        body: "must not escape",
      }),
      (error) => error === failure,
    )
  })

  it("rejects incomplete configuration", async () => {
    const plugin = createTinfoilPlugin(() => ({ fetch }))

    await assert.rejects(
      plugin(input, { apiKey: "test-key", models: {} }),
      /models must be a non-empty object/,
    )
    await assert.rejects(
      plugin(input, { providerID: "proxy", apiKey: "test-key" }),
      /models is required when providerID is not "tinfoil"/,
    )
    await assert.rejects(plugin(input, { apiKey: "" }), /apiKey must be a non-empty string/)
    await assert.rejects(plugin(input, { defaultProvider: "no" }), /defaultProvider must be a boolean/)
  })

  it("rejects invalid marked providers", async () => {
    const plugin = createTinfoilPlugin(() => ({ fetch }))
    const hooks = await plugin(input, { defaultProvider: false })

    await assert.rejects(
      hooks.config!({
        provider: { invalid: { options: { tinfoil: true } } },
      } as Config),
      /options.tinfoil must be an object/,
    )
    await assert.rejects(
      hooks.config!({
        provider: {
          invalid: {
            npm: "@ai-sdk/anthropic",
            options: { tinfoil: {} },
          },
        },
      } as Config),
      /must use @ai-sdk\/openai-compatible/,
    )
  })

  it("refuses to overwrite an existing provider", async () => {
    const plugin = createTinfoilPlugin(() => ({ fetch }))
    const hooks = await plugin(input, options)
    const config = {
      provider: { "private-inference": { name: "Plaintext provider" } },
    } as Config

    await assert.rejects(
      hooks.config!(config),
      /provider "private-inference" already exists/,
    )
  })
})
