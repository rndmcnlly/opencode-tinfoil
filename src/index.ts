import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { SecureClient } from "tinfoil"

const DEFAULT_BASE_URL = "https://inference.tinfoil.sh/v1/"

type ModelConfig = Record<string, unknown>
type SecureClientLike = { fetch: typeof fetch }
export type TinfoilSecureClientOptions = NonNullable<
  ConstructorParameters<typeof SecureClient>[0]
>
type SecureClientFactory = (options: TinfoilSecureClientOptions) => SecureClientLike

export interface TinfoilTransportOptions {
  attestationBundleURL?: string
  enclaveURL?: string
  configRepo?: string
  transport?: "ehbp" | "tls"
  userCacheSecret?: string
}

export interface TinfoilProviderOptions extends PluginOptions, TinfoilTransportOptions {
  providerID?: string
  name?: string
  apiKey?: string
  models?: Record<string, ModelConfig>
  baseURL?: string
}

export interface TinfoilPluginOptions extends TinfoilProviderOptions {
  defaultProvider?: boolean
}

type ParsedOptions = {
  providerID: string
  name: string
  apiKey?: string
  models?: Record<string, ModelConfig>
  baseURL: string
  secureClient: TinfoilSecureClientOptions
}

function nonEmptyString(value: unknown, field: string, fallback?: string): string {
  const resolved = value ?? fallback
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error(`opencode-tinfoil: ${field} must be a non-empty string`)
  }
  return resolved
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return nonEmptyString(value, field)
}

function parseSecureClient(
  options: Partial<TinfoilTransportOptions> & { baseURL?: unknown },
): { baseURL: string, secureClient: TinfoilSecureClientOptions } {
  const baseURL = nonEmptyString(options.baseURL, "baseURL", DEFAULT_BASE_URL)

  let parsedBaseURL: URL
  try {
    parsedBaseURL = new URL(baseURL)
  } catch {
    throw new Error("opencode-tinfoil: baseURL must be a valid HTTP(S) URL")
  }
  if (parsedBaseURL.protocol !== "http:" && parsedBaseURL.protocol !== "https:") {
    throw new Error("opencode-tinfoil: baseURL must be a valid HTTP(S) URL")
  }

  const transport = options.transport ?? "ehbp"
  if (transport !== "ehbp" && transport !== "tls") {
    throw new Error('opencode-tinfoil: transport must be "ehbp" or "tls"')
  }

  return {
    baseURL,
    secureClient: {
      baseURL,
      attestationBundleURL: optionalString(options.attestationBundleURL, "attestationBundleURL"),
      enclaveURL: optionalString(options.enclaveURL, "enclaveURL"),
      configRepo: optionalString(options.configRepo, "configRepo"),
      transport,
      userCacheSecret: optionalString(options.userCacheSecret, "userCacheSecret"),
    },
  }
}

function parseProvider(
  options: Partial<TinfoilProviderOptions>,
  configuredProviderID?: string,
): ParsedOptions {
  const providerID = nonEmptyString(
    configuredProviderID ?? options.providerID,
    "providerID",
    "tinfoil",
  )
  const secure = parseSecureClient(options)

  if (options.models !== undefined && (typeof options.models !== "object" || Array.isArray(options.models))) {
    throw new Error("opencode-tinfoil: models must be a non-empty object")
  }
  if (options.models && Object.keys(options.models).length === 0) {
    throw new Error("opencode-tinfoil: models must be a non-empty object")
  }
  if (!options.models && providerID !== "tinfoil") {
    throw new Error(
      'opencode-tinfoil: models is required when providerID is not "tinfoil"',
    )
  }

  return {
    providerID,
    name: nonEmptyString(options.name, "name", "Tinfoil"),
    apiKey: optionalString(options.apiKey, "apiKey"),
    models: options.models,
    baseURL: secure.baseURL,
    secureClient: secure.secureClient,
  }
}

function secureFetch(
  options: TinfoilSecureClientOptions,
  createClient: SecureClientFactory,
): typeof fetch {
  let client: SecureClientLike | undefined
  return async (input, init) => {
    client ??= createClient(options)
    return client.fetch(input, init)
  }
}

function parseOptions(options: PluginOptions): ParsedOptions[] {
  const typed = options as Partial<TinfoilPluginOptions>
  if (typed.defaultProvider !== undefined && typeof typed.defaultProvider !== "boolean") {
    throw new Error("opencode-tinfoil: defaultProvider must be a boolean")
  }
  return typed.defaultProvider === false ? [] : [parseProvider(typed)]
}

export function createTinfoilPlugin(
  createClient: SecureClientFactory = (options) => new SecureClient(options),
): Plugin {
  return async (_input, options = {}) => {
    const providers = parseOptions(options).map((parsed) => ({
      parsed,
      secureFetch: secureFetch(parsed.secureClient, createClient),
    }))

    return {
      config: async (config) => {
        config.provider ??= {}
        for (const { parsed } of providers) {
          if (config.provider[parsed.providerID]) {
            throw new Error(
              `opencode-tinfoil: provider "${parsed.providerID}" already exists`,
            )
          }
        }

        for (const [providerID, provider] of Object.entries(config.provider)) {
          const providerOptions = provider.options as Record<string, unknown> | undefined
          const marker = providerOptions?.tinfoil
          if (marker === undefined) continue
          if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
            throw new Error(
              `opencode-tinfoil: provider "${providerID}" options.tinfoil must be an object`,
            )
          }
          if (provider.npm && provider.npm !== "@ai-sdk/openai-compatible") {
            throw new Error(
              `opencode-tinfoil: provider "${providerID}" must use @ai-sdk/openai-compatible`,
            )
          }
          const parsed = parseSecureClient({
            ...(marker as Partial<TinfoilTransportOptions>),
            baseURL: providerOptions?.baseURL,
          })
          delete providerOptions!.tinfoil
          provider.npm = "@ai-sdk/openai-compatible"
          provider.options = {
            ...providerOptions,
            baseURL: parsed.baseURL,
            fetch: secureFetch(parsed.secureClient, createClient),
            includeUsage: true,
          }
        }

        for (const { parsed, secureFetch } of providers) {
          // OpenCode's generated config type does not model function-valued
          // provider options, but its provider runtime explicitly supports fetch.
          config.provider[parsed.providerID] = {
            npm: "@ai-sdk/openai-compatible",
            name: parsed.name,
            options: {
              baseURL: parsed.baseURL,
              fetch: secureFetch,
              includeUsage: true,
              ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
            },
            ...(parsed.models ? { models: parsed.models } : {}),
          } as never
        }
      },
    }
  }
}

export const Tinfoil: Plugin = createTinfoilPlugin()

export default Tinfoil
