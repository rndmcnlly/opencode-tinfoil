import { OpenAICompatible } from "@opencode/ai/providers/openai-compatible"
import { LanguageModel } from "@opencode/ai/schema/options"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { SecureClient } from "tinfoil"
import type { TinfoilSecureClientOptions } from "./index.js"

type Settings = Parameters<typeof OpenAICompatible.model>[1] & {
  tinfoil?: TinfoilSecureClientOptions
}

type SecureFetch = Pick<SecureClient, "fetch">

export function verifiedMiddleware(client: SecureFetch) {
  return (outgoing: HttpClientRequest.HttpClientRequest) => {
    const body = outgoing.body
    if (body._tag !== "Uint8Array") {
      return Effect.fail(new Error("opencode-tinfoil: unexpected inference body format"))
    }
    return Effect.tryPromise({
      try: async () => {
        const response = await client.fetch(outgoing.url, {
          method: outgoing.method,
          headers: outgoing.headers,
          body: body.body,
        })
        return HttpClientResponse.fromWeb(outgoing, response)
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    })
  }
}

// An HTTP middleware is attached to the route itself: the ordinary HTTP
// handler is deliberately never invoked, even if attestation fails.
export const model = (modelID: string, settings: Settings) => {
  const { tinfoil, ...connection } = settings
  if (!tinfoil || typeof tinfoil !== "object" || Array.isArray(tinfoil)) {
    throw new Error("opencode-tinfoil: missing verified transport settings")
  }
  const baseURL = tinfoil.baseURL ?? connection.baseURL
  if (typeof connection.baseURL !== "string" || baseURL !== connection.baseURL) {
    throw new Error("opencode-tinfoil: transport and provider baseURL must match")
  }
  const transportMode = tinfoil.transport ?? "ehbp"
  if (transportMode !== "ehbp" && transportMode !== "tls") {
    throw new Error("opencode-tinfoil: invalid transport")
  }
  const client = new SecureClient({ ...tinfoil, baseURL, transport: transportMode })
  const base = OpenAICompatible.model(modelID, connection)
  const transport = base.route.transport
  const secured = base.route.with({
    transport: {
      ...transport,
      execute: (prepared, request, runtime, options) => transport.execute(
        { ...prepared, middleware: verifiedMiddleware(client) }, request, runtime, options,
      ),
    },
  })
  return LanguageModel.update(base, { route: secured })
}
