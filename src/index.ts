import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { SecureClient } from "tinfoil"

const DEFAULT_BASE_URL = "https://inference.tinfoil.sh/v1/"

type ModelConfig = Record<string, unknown>
type SecureClientLike = { fetch: typeof fetch }
export type TinfoilSecureClientOptions = NonNullable<
  ConstructorParameters<typeof SecureClient>[0]
>
type SecureClientFactory = (options: TinfoilSecureClientOptions) => SecureClientLike

export interface TinfoilPluginOptions extends PluginOptions {
  providerID?: string
  name?: string
  apiKey: string
  models?: Record<string, ModelConfig>
  baseURL?: string
  attestationBundleURL?: string
  enclaveURL?: string
  configRepo?: string
  transport?: "ehbp" | "tls"
  userCacheSecret?: string
}

type ParsedOptions = {
  providerID: string
  name: string
  apiKey: string
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

function parseOptions(options: PluginOptions): ParsedOptions {
  const typed = options as Partial<TinfoilPluginOptions>
  const providerID = nonEmptyString(typed.providerID, "providerID", "tinfoil")
  const baseURL = nonEmptyString(typed.baseURL, "baseURL", DEFAULT_BASE_URL)

  let parsedBaseURL: URL
  try {
    parsedBaseURL = new URL(baseURL)
  } catch {
    throw new Error("opencode-tinfoil: baseURL must be a valid HTTP(S) URL")
  }
  if (parsedBaseURL.protocol !== "http:" && parsedBaseURL.protocol !== "https:") {
    throw new Error("opencode-tinfoil: baseURL must be a valid HTTP(S) URL")
  }

  if (typed.models !== undefined && (typeof typed.models !== "object" || Array.isArray(typed.models))) {
    throw new Error("opencode-tinfoil: models must be a non-empty object")
  }
  if (typed.models && Object.keys(typed.models).length === 0) {
    throw new Error("opencode-tinfoil: models must be a non-empty object")
  }
  if (!typed.models && providerID !== "tinfoil") {
    throw new Error(
      'opencode-tinfoil: models is required when providerID is not "tinfoil"',
    )
  }

  const transport = typed.transport ?? "ehbp"
  if (transport !== "ehbp" && transport !== "tls") {
    throw new Error('opencode-tinfoil: transport must be "ehbp" or "tls"')
  }

  return {
    providerID,
    name: nonEmptyString(typed.name, "name", "Tinfoil"),
    apiKey: nonEmptyString(typed.apiKey, "apiKey"),
    models: typed.models,
    baseURL,
    secureClient: {
      baseURL,
      attestationBundleURL: optionalString(typed.attestationBundleURL, "attestationBundleURL"),
      enclaveURL: optionalString(typed.enclaveURL, "enclaveURL"),
      configRepo: optionalString(typed.configRepo, "configRepo"),
      transport,
      userCacheSecret: optionalString(typed.userCacheSecret, "userCacheSecret"),
    },
  }
}

export function createTinfoilPlugin(
  createClient: SecureClientFactory = (options) => new SecureClient(options),
): Plugin {
  return async (_input, options = {}) => {
    const parsed = parseOptions(options)
    let client: SecureClientLike | undefined

    const secureFetch: typeof fetch = async (input, init) => {
      client ??= createClient(parsed.secureClient)
      return client.fetch(input, init)
    }

    return {
      config: async (config) => {
        config.provider ??= {}
        if (config.provider[parsed.providerID]) {
          throw new Error(
            `opencode-tinfoil: provider "${parsed.providerID}" already exists`,
          )
        }

        // OpenCode's generated config type does not model function-valued
        // provider options, but its provider runtime explicitly supports fetch.
        config.provider[parsed.providerID] = {
          npm: "@ai-sdk/openai-compatible",
          name: parsed.name,
          options: {
            apiKey: parsed.apiKey,
            baseURL: parsed.baseURL,
            fetch: secureFetch,
            includeUsage: true,
          },
          ...(parsed.models ? { models: parsed.models } : {}),
        } as never
      },
    }
  }
}

export const Tinfoil: Plugin = createTinfoilPlugin()

export default Tinfoil
