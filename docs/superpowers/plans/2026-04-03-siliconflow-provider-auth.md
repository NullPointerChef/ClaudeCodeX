# SiliconFlow Provider Auth Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SiliconFlow use its own `SILICONFLOW_API_KEY` (and optional `SILICONFLOW_BASE_URL`) only when the active provider is `siliconflow`, without affecting Anthropic, OpenAI, OpenRouter, or custom provider flows.

**Architecture:** Keep SiliconFlow inside the existing OpenAI-compatible provider system, but add provider-specific environment-variable resolution in `providerConfig.ts` instead of relying on the shared `OPENAI_COMPAT_API_KEY`/`OPENAI_COMPAT_BASE_URL`. Update the `/provider` command to surface the correct env-var guidance and to build the active config with SiliconFlow-specific base URL rules.

**Tech Stack:** Bun, TypeScript, React/Ink command UI, Bun test runner

---

## File map

- Modify: `src/services/api/openai/providerConfig.ts`
  - Centralize provider-specific auth/baseURL resolution.
  - Teach SiliconFlow to read `SILICONFLOW_API_KEY` and optional `SILICONFLOW_BASE_URL`.
  - Keep existing OpenAI Codex and generic provider behavior unchanged.
- Modify: `src/commands/provider/provider.tsx`
  - Use provider-specific baseURL resolution when activating a provider.
  - Show SiliconFlow-specific help/error text instead of generic `OPENAI_COMPAT_API_KEY` guidance.
- Modify: `src/services/api/openai/__tests__/providerConfig.test.ts`
  - Add regression coverage proving SiliconFlow env vars are isolated from other providers.

### Task 1: Add provider-specific SiliconFlow env resolution

**Files:**
- Modify: `src/services/api/openai/providerConfig.ts`
- Test: `src/services/api/openai/__tests__/providerConfig.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
process.env.SILICONFLOW_API_KEY = 'sf-key'
process.env.OPENAI_COMPAT_API_KEY = 'shared-key'
expect(resolveProviderAuthentication('siliconflow')).toEqual({
  apiKey: 'sf-key',
  useResponsesApi: false,
})

expect(resolveProviderAuthentication('openrouter', 'stored-openrouter-key')).toEqual({
  apiKey: 'shared-key',
  useResponsesApi: false,
})
```

Add another test for base URL selection:

```ts
process.env.OPENAI_COMPAT_PROVIDER = 'siliconflow'
process.env.SILICONFLOW_API_KEY = 'sf-key'
process.env.SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
expect(getOpenAICompatConfig()?.baseURL).toBe('https://api.siliconflow.cn/v1')
```

- [ ] **Step 2: Run the focused test file to verify it fails**

Run: `bun test src/services/api/openai/__tests__/providerConfig.test.ts`
Expected: FAIL because SiliconFlow still resolves through shared OpenAI-compatible env vars.

- [ ] **Step 3: Implement minimal provider-specific resolution**

In `src/services/api/openai/providerConfig.ts`:

```ts
function getProviderEnvApiKey(providerName: ProviderName): string | undefined {
  if (providerName === 'siliconflow') {
    return process.env.SILICONFLOW_API_KEY
  }
  return process.env.OPENAI_COMPAT_API_KEY
}

function getProviderEnvBaseURL(providerName: ProviderName): string | undefined {
  if (providerName === 'siliconflow') {
    return process.env.SILICONFLOW_BASE_URL
  }
  return process.env.OPENAI_COMPAT_BASE_URL
}
```

Then use those helpers in:
- `resolveProviderAuthentication()`
- `getOpenAICompatConfig()` env fallback path
- `fetchProviderModels()` when building the `/models` URL

Preserve the existing special case for `openai` + Codex ChatGPT auth.

- [ ] **Step 4: Re-run the focused test file**

Run: `bun test src/services/api/openai/__tests__/providerConfig.test.ts`
Expected: PASS with new SiliconFlow isolation coverage.

### Task 2: Update `/provider` command messaging and activation

**Files:**
- Modify: `src/commands/provider/provider.tsx`
- Reuse: `src/services/api/openai/providerConfig.ts`

- [ ] **Step 1: Add a failing expectation or manual assertion target**

Document the desired UX before editing:
- `/provider help` should mention `SILICONFLOW_API_KEY` / `SILICONFLOW_BASE_URL` for SiliconFlow.
- Switching to `siliconflow` should not tell the user to set `OPENAI_COMPAT_API_KEY`.
- Activating SiliconFlow should use `SILICONFLOW_BASE_URL` when present; other providers should keep using their current base URL rules.

- [ ] **Step 2: Implement minimal command changes**

In `src/commands/provider/provider.tsx`:
- Add a small helper for provider-specific missing-key guidance.
- Add a small helper for provider-specific baseURL selection when building `OpenAIProviderConfig`.
- Update help text so the generic shared-env description no longer implies SiliconFlow uses `OPENAI_COMPAT_API_KEY`.

Target behavior:

```ts
if (providerName === 'siliconflow') {
  return 'Set SILICONFLOW_API_KEY first'
}
```

and

```ts
const baseURL = providerName === 'siliconflow'
  ? (process.env.SILICONFLOW_BASE_URL || preset.baseURL)
  : (process.env.OPENAI_COMPAT_BASE_URL || preset.baseURL)
```

- [ ] **Step 3: Smoke-check provider command behavior**

Run: `bun test src/services/api/openai/__tests__/providerConfig.test.ts`
Expected: PASS

Then optionally run a manual smoke check:

Run: `bun run src/entrypoints/cli.tsx -p "/provider help"`
Expected: output references SiliconFlow-specific env vars and does not require changing Anthropic/OpenAI/OpenRouter config.

### Task 3: Verify no regression to other providers

**Files:**
- Test: `src/services/api/openai/__tests__/providerConfig.test.ts`
- Inspect: `src/commands/provider/provider.tsx`

- [ ] **Step 1: Add regression assertions for non-SiliconFlow providers**

Keep or add tests proving:
- OpenAI still prefers Codex ChatGPT auth.
- OpenRouter/custom still use `OPENAI_COMPAT_API_KEY`.
- Persisted per-provider keys still work when env vars are absent.

- [ ] **Step 2: Run focused verification**

Run: `bun test src/services/api/openai/__tests__/providerConfig.test.ts`
Expected: PASS

- [ ] **Step 3: Run broader verification if the focused test touched shared helpers**

Run: `bun test src/services/api/openai/__tests__/OpenAICompatClient.test.ts`
Expected: PASS

- [ ] **Step 4: Stop without committing**

Do not create a commit unless the user explicitly asks for one.

## Notes for implementation

- Do **not** write the user-provided SiliconFlow key into the repo.
- Do **not** change Anthropic auth flow.
- Do **not** make SiliconFlow fall back to `OPENAI_COMPAT_API_KEY`; isolation is the requirement.
- Keep changes local to provider selection/resolution and tests; avoid unrelated refactors.
