import type { Plugin } from "@opencode/plugin"

export const V2_PACKAGE = "opencode-tinfoil/provider"

// The V1 well-known config format remains supported by V2. Its provider
// registrations may run after ours, so upgrade models only after all providers
// are available. Reject marked providers with an unexpected package.
export const TinfoilV2: Plugin.Plugin = {
  id: "opencode-tinfoil",
  async setup(ctx) {
    const defaultProvider = ctx.options.defaultProvider !== false
    if (ctx.options.defaultProvider !== undefined && typeof ctx.options.defaultProvider !== "boolean") {
      throw new Error("opencode-tinfoil: defaultProvider must be a boolean")
    }
    await ctx.model.transform((editor) => {
      for (const { provider } of editor.provider.list()) {
        const marked = provider.settings?.tinfoil !== undefined
        if (!marked && !(defaultProvider && provider.id === "tinfoil")) continue
        const providerID = String(provider.id)
        for (const model of editor.list(providerID)) {
          const modelID = String(model.id)
          if (marked && (provider.package === V2_PACKAGE || provider.package === "@opencode/ai/providers/openai-compatible")) {
            editor.update(providerID, modelID, (draft) => { draft.package = V2_PACKAGE })
          } else {
            editor.remove(providerID, modelID)
          }
        }
      }
    })
  },
}
