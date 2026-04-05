import type {
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type OpenAI from 'openai'
import { debugLog } from './debugLog.js'
import type { ThinkingMode } from './providerConfig.js'
import { ThinkTagExtractor } from './thinkingHandler.js'

type ChatCompletionChunk = OpenAI.ChatCompletionChunk

/**
 * FakeStream wraps an async generator to look like the Anthropic SDK's
 * Stream<BetaRawMessageStreamEvent>. claude.ts accesses:
 * - [Symbol.asyncIterator]() to iterate events
 * - .controller.abort() for cleanup
 */
export class FakeStream
  implements AsyncIterable<BetaRawMessageStreamEvent>
{
  readonly controller: AbortController

  constructor(
    private readonly gen: AsyncGenerator<BetaRawMessageStreamEvent>,
    controller: AbortController,
  ) {
    this.controller = controller
  }

  [Symbol.asyncIterator]() {
    return this.gen
  }
}

/**
 * Translate an OpenAI streaming response into Anthropic SSE events.
 */
export function createAnthropicStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  abortController: AbortController,
  model: string,
  thinkingMode: ThinkingMode,
): FakeStream {
  const gen = translateStream(
    openaiStream,
    model,
    thinkingMode,
    abortController,
  )
  return new FakeStream(gen, abortController)
}

async function* translateStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  thinkingMode: ThinkingMode,
  abortController: AbortController,
): AsyncGenerator<BetaRawMessageStreamEvent> {
  const _debug = !!process.env.DEBUG_OPENAI
  let messageStarted = false
  let stopEmitted = false
  let inputTokens = 0

  // Block index tracking
  let nextBlockIndex = 0
  let thinkingBlockIndex = -1
  let thinkingBlockOpen = false
  let textBlockIndex = -1
  let textBlockOpen = false
  const toolBlockIndices = new Map<number, number>() // openai tc.index → our block index

  const thinkTagExtractor =
    thinkingMode.type === 'think_tags' ? new ThinkTagExtractor() : null

  try {
    for await (const chunk of openaiStream) {
      if (abortController.signal.aborted) break

      const choice = chunk.choices?.[0]
      if (!choice) {
        // Usage-only chunk (OpenAI sends usage in a final chunk with no choices)
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0
        }
        continue
      }

      // ── message_start (once) ──
      if (!messageStarted) {
        messageStarted = true
        inputTokens = chunk.usage?.prompt_tokens ?? 0
        yield {
          type: 'message_start',
          message: {
            id: chunk.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        } as BetaRawMessageStreamEvent
      }

      const delta = choice.delta as Record<string, any>

      // ── Reasoning content ──
      // Check both `reasoning_content` (OpenAI native) and `reasoning`
      // (OpenRouter normalised). This runs for ALL thinking modes so that
      // providers that normalise thinking into a dedicated field are handled
      // even when the mode is `none` or `think_tags`.
      const reasoningDelta =
        delta.reasoning_content ?? delta.reasoning ?? null
      if (reasoningDelta) {
        if (!thinkingBlockOpen) {
          thinkingBlockOpen = true
          thinkingBlockIndex = nextBlockIndex++
          yield {
            type: 'content_block_start',
            index: thinkingBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
          } as BetaRawMessageStreamEvent
        }
        yield {
          type: 'content_block_delta',
          index: thinkingBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoningDelta,
          },
        } as BetaRawMessageStreamEvent
      }

      // ── Text content ──
      if (delta.content != null && delta.content !== '') {
        if (thinkTagExtractor) {
          // Deepseek-style: split <think> tags
          const { thinking, text } = thinkTagExtractor.extract(
            delta.content,
          )
          if (thinking) {
            yield* emitThinking(thinking)
          }
          if (text) {
            yield* emitText(text)
          }
        } else {
          yield* emitText(delta.content)
        }
      }

      // ── Tool calls ──
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls as Array<Record<string, any>>) {
          const tcIndex = tc.index ?? 0

          // First chunk for this tool call has id and name
          if (tc.id) {
            // Close text block if open before starting tool blocks
            if (textBlockOpen) {
              textBlockOpen = false
              yield {
                type: 'content_block_stop',
                index: textBlockIndex,
              } as BetaRawMessageStreamEvent
            }

            const blockIdx = nextBlockIndex++
            toolBlockIndices.set(tcIndex, blockIdx)
            yield {
              type: 'content_block_start',
              index: blockIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name ?? '',
                input: {},
              },
            } as BetaRawMessageStreamEvent
          }

          // Argument fragments
          if (tc.function?.arguments) {
            const blockIdx = toolBlockIndices.get(tcIndex)
            if (blockIdx !== undefined) {
              yield {
                type: 'content_block_delta',
                index: blockIdx,
                delta: {
                  type: 'input_json_delta',
                  partial_json: tc.function.arguments,
                },
              } as BetaRawMessageStreamEvent
            }
          }
        }
      }

      // ── Finish ──
      if (choice.finish_reason) debugLog(`[DEBUG_OPENAI] stream finish_reason=${choice.finish_reason}, textBlockOpen=${textBlockOpen}, toolBlocks=${toolBlockIndices.size}`)
      if (choice.finish_reason) {
        // Flush think tag extractor
        if (thinkTagExtractor) {
          const { thinking, text } = thinkTagExtractor.flush()
          if (thinking) {
            yield* emitThinking(thinking)
          }
          if (text) {
            yield* emitText(text)
          }
        }

        // Close thinking block
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_delta',
            index: thinkingBlockIndex,
            delta: { type: 'signature_delta', signature: 'openai-compat' },
          } as BetaRawMessageStreamEvent
          yield {
            type: 'content_block_stop',
            index: thinkingBlockIndex,
          } as BetaRawMessageStreamEvent
        }

        // Close text block
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: textBlockIndex,
          } as BetaRawMessageStreamEvent
        }

        // Close tool blocks
        for (const [, blockIdx] of toolBlockIndices) {
          yield {
            type: 'content_block_stop',
            index: blockIdx,
          } as BetaRawMessageStreamEvent
        }

        const outputTokens = chunk.usage?.completion_tokens ?? 0
        // Update input tokens if available in final chunk
        if (chunk.usage?.prompt_tokens) {
          inputTokens = chunk.usage.prompt_tokens
        }

        yield {
          type: 'message_delta',
          context_management: null,
          delta: {
            stop_reason: translateStopReason(choice.finish_reason),
            stop_sequence: null,
            container: null,
          },
          usage: {
            output_tokens: outputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: null,
            iterations: null,
          },
        } as BetaRawMessageStreamEvent
        yield { type: 'message_stop' } as BetaRawMessageStreamEvent
        stopEmitted = true
      }
    }
  } catch (err) {
    debugLog(`[DEBUG_OPENAI] stream error: aborted=${abortController.signal.aborted}, err=${err instanceof Error ? err.message : String(err)}`)
    if (abortController.signal.aborted) return
    throw err
  }

  debugLog(`[DEBUG_OPENAI] stream ended: messageStarted=${messageStarted}, stopEmitted=${stopEmitted}, textBlockOpen=${textBlockOpen}, toolBlocks=${toolBlockIndices.size}`)
  // If stream ended without finish_reason (e.g., network error or non-standard provider),
  // close any open blocks and emit message_delta + message_stop so the Anthropic SDK
  // consumer doesn't hang or silently drop the message.
  if (messageStarted && !stopEmitted) {
    // Close thinking block
    if (thinkingBlockOpen) {
      yield {
        type: 'content_block_delta',
        index: thinkingBlockIndex,
        delta: { type: 'signature_delta', signature: 'openai-compat' },
      } as BetaRawMessageStreamEvent
      yield {
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      } as BetaRawMessageStreamEvent
    }
    // Close text block
    if (textBlockOpen) {
      yield {
        type: 'content_block_stop',
        index: textBlockIndex,
      } as BetaRawMessageStreamEvent
    }
    // Close tool blocks
    for (const [, blockIdx] of toolBlockIndices) {
      yield {
        type: 'content_block_stop',
        index: blockIdx,
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'message_delta',
      context_management: null,
      delta: {
        stop_reason: toolBlockIndices.size > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        container: null,
      },
      usage: {
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: null,
        iterations: null,
      },
    } as BetaRawMessageStreamEvent
    yield { type: 'message_stop' } as BetaRawMessageStreamEvent
  }

  // ── Helper closures (capture mutable state from outer scope) ──

  function* emitThinking(
    content: string,
  ): Generator<BetaRawMessageStreamEvent> {
    if (!thinkingBlockOpen) {
      thinkingBlockOpen = true
      thinkingBlockIndex = nextBlockIndex++
      yield {
        type: 'content_block_start',
        index: thinkingBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'content_block_delta',
      index: thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking: content },
    } as BetaRawMessageStreamEvent
  }

  function* emitText(
    content: string,
  ): Generator<BetaRawMessageStreamEvent> {
    if (!textBlockOpen) {
      textBlockOpen = true
      textBlockIndex = nextBlockIndex++
      yield {
        type: 'content_block_start',
        index: textBlockIndex,
        content_block: { type: 'text', text: '' },
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'content_block_delta',
      index: textBlockIndex,
      delta: { type: 'text_delta', text: content },
    } as BetaRawMessageStreamEvent
  }
}

function translateStopReason(
  openaiReason: string,
): BetaStopReason {
  switch (openaiReason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}
