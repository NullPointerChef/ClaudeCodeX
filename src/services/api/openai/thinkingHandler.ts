import type { ProviderName, ThinkingMode } from './providerConfig.js'
import { getOpenAIModelInfo, myclawEffortToCodex } from './modelCatalog.js'

/**
 * Infer thinking mode from provider + model name when no explicit config override.
 *
 * Two thinking mechanisms are supported:
 * - `reasoning_effort`: OpenAI o-series / codex — sends `reasoning_effort` param,
 *   reads `reasoning_content` from response.
 * - `think_tags`: Models that embed `<think>...</think>` tags in the output text
 *   (DeepSeek R1, QwQ, QVQ, GLM-Z1, etc.).
 *
 * The stream adapter also opportunistically reads `reasoning_content` / `reasoning`
 * fields from any model, so even if the mode is `none` the thinking content will
 * still be captured when the provider normalises it into a dedicated field.
 */
export function inferThinkingMode(
  _providerName: ProviderName,
  model: string,
  configOverride?: ThinkingMode,
): ThinkingMode {
  if (configOverride && configOverride.type !== 'none') return configOverride

  const m = model.toLowerCase()
  // Strip provider prefix for matching (e.g. "openai/o3-mini" → "o3-mini")
  const base = m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m

  // ── reasoning_effort mode ─────────────────────────────────────────────────
  // OpenAI o-series and codex
  if (
    base.startsWith('o1') ||
    base.startsWith('o3') ||
    base.startsWith('o4') ||
    base.startsWith('codex')
  ) {
    const catalogInfo = getOpenAIModelInfo(model)
    const defaultLevel = catalogInfo
      ? myclawEffortToCodex(catalogInfo.defaultEffort)
      : 'high'
    return { type: 'reasoning_effort', level: defaultLevel }
  }

  // GPT-5+ models with reasoning support (from catalog)
  if (base.startsWith('gpt-5')) {
    const catalogInfo = getOpenAIModelInfo(model)
    if (catalogInfo) {
      const defaultLevel = myclawEffortToCodex(catalogInfo.defaultEffort)
      return { type: 'reasoning_effort', level: defaultLevel }
    }
  }

  // ── think_tags mode ───────────────────────────────────────────────────────

  // DeepSeek reasoning models (R1, R1-0528, R1-Distill-*, etc.)
  if (
    base.startsWith('deepseek-r') ||
    (m.includes('deepseek') && (m.includes('reasoner') || m.includes('-r1')))
  ) {
    return { type: 'think_tags' }
  }

  // Qwen reasoning: QwQ (text), QVQ (visual)
  if (m.includes('qwq') || m.includes('qvq')) {
    return { type: 'think_tags' }
  }

  // GLM-Z1 推理系列 — embeds <think> tags in content
  if (m.includes('glm-z1')) {
    return { type: 'think_tags' }
  }

  // GLM-4.5+, GLM-4.7, GLM-5 use reasoning_content field (handled by stream adapter).
  // Non-reasoning GLM (GLM-4, GLM-4-Flash, etc.) have no thinking output.
  // Both cases: mode none is correct; stream adapter picks up reasoning_content automatically.
  if (m.includes('glm')) {
    return { type: 'none' }
  }

  // Marco-O1 (MFAI reasoning model)
  if (m.includes('marco-o1')) {
    return { type: 'think_tags' }
  }

  // Skywork / Sky-T1 reasoning
  if (base.startsWith('sky-t1') || (m.includes('skywork') && m.includes('think'))) {
    return { type: 'think_tags' }
  }

  // Microsoft Phi reasoning
  if (m.includes('phi') && m.includes('reason')) {
    return { type: 'think_tags' }
  }

  // Kimi K1/K2 reasoning (Moonshot)
  if (m.includes('k1.5') || (m.includes('kimi') && /k[12]/.test(m))) {
    return { type: 'think_tags' }
  }

  // Xiaomi MiMo reasoning
  if (m.includes('mimo') && (m.includes('reason') || m.includes('think'))) {
    return { type: 'think_tags' }
  }

  // Step reasoning (Jieyue Xingchen / StepFun)
  if (m.includes('step') && (m.includes('reason') || m.includes('think'))) {
    return { type: 'think_tags' }
  }

  // OpenRouter `:thinking` variant suffix (e.g. "deepseek/deepseek-chat:thinking")
  if (m.endsWith(':thinking')) {
    return { type: 'think_tags' }
  }

  // Generic heuristic: common reasoning indicators in model name
  if (
    base.includes('-thinking') ||
    base.includes('-reasoner') ||
    base.includes('-reason-')
  ) {
    return { type: 'think_tags' }
  }

  return { type: 'none' }
}

/**
 * Extra request params for OpenAI chat completions based on thinking mode.
 */
export function getThinkingRequestParams(
  mode: ThinkingMode,
): Record<string, unknown> {
  if (mode.type === 'reasoning_effort') {
    return { reasoning_effort: mode.level }
  }
  return {}
}

// ─── Streaming <think> tag extractor ─────────────────────────────────────────

/**
 * Stateful extractor that parses `<think>...</think>` tags from streaming text.
 * Used for Deepseek-style reasoning models that embed thinking in the content.
 */
export class ThinkTagExtractor {
  private inThinkBlock = false
  private buffer = ''

  /**
   * Process an incoming text delta and split it into thinking vs. text content.
   */
  extract(delta: string): { thinking: string; text: string } {
    this.buffer += delta
    let thinking = ''
    let text = ''

    while (this.buffer.length > 0) {
      if (this.inThinkBlock) {
        const endIdx = this.buffer.indexOf('</think>')
        if (endIdx !== -1) {
          thinking += this.buffer.slice(0, endIdx)
          this.buffer = this.buffer.slice(endIdx + '</think>'.length)
          this.inThinkBlock = false
        } else {
          // Might be a partial `</think>` at the end — keep last 8 chars buffered
          const safeLen = Math.max(0, this.buffer.length - 8)
          thinking += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
      } else {
        const startIdx = this.buffer.indexOf('<think>')
        if (startIdx !== -1) {
          text += this.buffer.slice(0, startIdx)
          this.buffer = this.buffer.slice(startIdx + '<think>'.length)
          this.inThinkBlock = true
        } else {
          // Might be a partial `<think>` at the end — keep last 7 chars buffered
          const safeLen = Math.max(0, this.buffer.length - 7)
          text += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
      }
    }

    return { thinking, text }
  }

  /** Flush any remaining buffer content. */
  flush(): { thinking: string; text: string } {
    const remaining = this.buffer
    this.buffer = ''
    if (this.inThinkBlock) {
      return { thinking: remaining, text: '' }
    }
    return { thinking: '', text: remaining }
  }
}
