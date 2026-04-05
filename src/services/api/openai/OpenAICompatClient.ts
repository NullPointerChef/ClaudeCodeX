import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import OpenAI from 'openai'
import { debugLog } from './debugLog.js'
import { mapOpenAIError } from './errorMapper.js'
import {
  translateMessages,
  translateSystemPrompt,
  translateToolChoice,
  translateTools,
} from './messageTranslator.js'
import type { OpenAIProviderConfig, ThinkingMode } from './providerConfig.js'
import { createAnthropicStream } from './streamAdapter.js'
import { createResponsesApiStream } from './responsesClient.js'
import type { ResponsesTransportSummary } from './responsesTelemetry.js'
import {
  getThinkingRequestParams,
  inferThinkingMode,
} from './thinkingHandler.js'
import { myclawEffortToCodex } from './modelCatalog.js'

/**
 * A proxy client that mimics the Anthropic SDK's `beta.messages.create()` interface
 * but internally uses the OpenAI SDK. This lets claude.ts work unchanged.
 */
export class OpenAICompatClient {
  private openai: OpenAI
  private config: OpenAIProviderConfig

  readonly beta: {
    messages: {
      create: (
        params: BetaMessageStreamParams & { stream?: boolean },
        options?: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> },
      ) => PromiseWithResponse
    }
  }

  constructor(config: OpenAIProviderConfig) {
    this.config = config
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      dangerouslyAllowBrowser: true,
      timeout: Math.floor(Number(process.env.API_TIMEOUT_MS) || 600_000),
    })

    // Bind methods
    const self = this
    this.beta = {
      messages: {
        create(params, options) {
          return self._create(params, options)
        },
      },
    }
  }

  private _create(
    params: BetaMessageStreamParams & { stream?: boolean },
    options?: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> },
  ): PromiseWithResponse {
    // Route to Responses API for Codex ChatGPT auth
    if (this.config.useResponsesApi) {
      if (params.stream === false) {
        return this._createResponsesNonStreaming(params, options)
      }
      return createResponsesApiStream(params, this.config, options)
    }

    const isStreaming = params.stream !== false

    if (isStreaming) {
      return this._createStreaming(params, options)
    }
    return this._createNonStreaming(params, options)
  }

  private _createStreaming(
    params: BetaMessageStreamParams,
    options?: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> },
  ): PromiseWithResponse {
    const thinkingMode = inferThinkingMode(
      this.config.providerName,
      this.config.model,
      this.config.thinkingMode,
    )

    const openaiParams = this._translateParams(params, thinkingMode)

    // The actual promise that creates the stream
    const streamPromise = (async () => {
      try {
        const abortController = new AbortController()

        // Forward external signal to our abort controller
        if (options?.signal) {
          if (options.signal.aborted) {
            abortController.abort()
          } else {
            options.signal.addEventListener('abort', () => {
              abortController.abort()
            })
          }
        }

        {
          debugLog(`[DEBUG_OPENAI] _createStreaming: model=${openaiParams.model}, messages=${openaiParams.messages.length}`)
          for (const m of openaiParams.messages) {
            const role = m.role
            const content = 'content' in m ? (typeof m.content === 'string' ? m.content.slice(0, 80) : JSON.stringify(m.content)?.slice(0, 80)) : ''
            const tc = 'tool_calls' in m ? `tool_calls=${(m as any).tool_calls?.length}` : ''
            const tcid = 'tool_call_id' in m ? `tool_call_id=${(m as any).tool_call_id}` : ''
            debugLog(`[DEBUG_OPENAI]   ${role}: ${content} ${tc} ${tcid}`.trimEnd())
          }
        }

        const openaiStream = await this.openai.chat.completions.create(
          {
            ...openaiParams,
            stream: true,
            stream_options: { include_usage: true },
          },
          {
            signal: abortController.signal,
            ...(options?.timeout != null && { timeout: Math.floor(options.timeout) }),
          },
        )

        debugLog(`[DEBUG_OPENAI] _createStreaming: stream created OK`)

        const fakeStream = createAnthropicStream(
          openaiStream,
          abortController,
          this.config.model,
          thinkingMode,
        )

        return fakeStream
      } catch (err) {
        debugLog(`[DEBUG_OPENAI] _createStreaming error:`, err instanceof Error ? err.message : String(err))
        throw mapOpenAIError(err)
      }
    })()

    // Wrap as PromiseWithResponse so .withResponse() works
    return makePromiseWithResponse(streamPromise)
  }

  private _createNonStreaming(
    params: BetaMessageStreamParams & { stream?: boolean },
    options?: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> },
  ): PromiseWithResponse {
    const thinkingMode = inferThinkingMode(
      this.config.providerName,
      this.config.model,
      this.config.thinkingMode,
    )

    const openaiParams = this._translateParams(params, thinkingMode)

    const resultPromise = (async () => {
      try {
        const resp = await this.openai.chat.completions.create(
          { ...openaiParams, stream: false },
          {
            signal: options?.signal,
            ...(options?.timeout != null && { timeout: Math.floor(options.timeout) }),
          },
        )

        return translateCompletion(resp, this.config.model, thinkingMode)
      } catch (err) {
        throw mapOpenAIError(err)
      }
    })()

    return makePromiseWithResponse(resultPromise)
  }

  private _createResponsesNonStreaming(
    params: BetaMessageStreamParams & { stream?: boolean },
    options?: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> },
  ): PromiseWithResponse {
    let resolveResponseInfo: ((info: {
      request_id: string | null
      transport_info?: ResponsesTransportSummary
      response: { headers: Headers }
    }) => void) | null = null

    const responseInfoPromise = new Promise<{
      request_id: string | null
      transport_info?: ResponsesTransportSummary
      response: { headers: Headers }
    }>(resolve => {
      resolveResponseInfo = resolve
    })

    const resultPromise = (async () => {
      try {
        const streamResult = await createResponsesApiStream(
          {
            ...params,
            stream: true,
          },
          this.config,
          options,
        ).withResponse()

        resolveResponseInfo?.({
          request_id: streamResult.request_id,
          transport_info: streamResult.transport_info,
          response: { headers: streamResult.response.headers },
        })

        return await collectStreamToBetaMessage(
          streamResult.data as AsyncIterable<BetaRawMessageStreamEvent>,
          this.config.model,
        )
      } catch (err) {
        resolveResponseInfo?.({
          request_id: null,
          transport_info: undefined,
          response: { headers: new Headers() },
        })
        throw err
      }
    })()

    return makePromiseWithResponse(resultPromise, responseInfoPromise)
  }

  private _translateParams(
    params: BetaMessageStreamParams,
    thinkingMode: ThinkingMode,
  ): OpenAI.ChatCompletionCreateParams {
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    // System prompt → system message
    const systemText = translateSystemPrompt(params.system as any)
    if (systemText) {
      messages.push({ role: 'system', content: systemText })
    }

    // Conversation messages
    messages.push(...translateMessages(params.messages))

    const tools = translateTools(params.tools as any)
    const toolChoice = translateToolChoice(params.tool_choice)

    // Dynamic effort override: if params carry output_config.effort (set by
    // claude.ts from the resolved effort), use it instead of the static
    // config.thinkingMode so /effort commands take effect for Chat Completions.
    let effectiveThinkingMode = thinkingMode
    const paramsEffort = (params as any).output_config?.effort as string | undefined
    if (paramsEffort && thinkingMode.type === 'reasoning_effort') {
      effectiveThinkingMode = {
        type: 'reasoning_effort',
        level: myclawEffortToCodex(paramsEffort as any),
      }
    }

    const result: OpenAI.ChatCompletionCreateParams = {
      // Always use the configured model, not the Claude model name from params
      model: this.config.model,
      messages,
      max_completion_tokens: params.max_tokens,
      ...(params.temperature != null && { temperature: params.temperature }),
      ...(tools && { tools }),
      ...(toolChoice && { tool_choice: toolChoice }),
      ...getThinkingRequestParams(effectiveThinkingMode),
    }

    return result
  }
}

// ─── Non-streaming response translation ──────────────────────────────────────

function translateCompletion(
  resp: OpenAI.ChatCompletion,
  model: string,
  _thinkingMode: ThinkingMode,
): BetaMessage {
  const choice = resp.choices[0]
  if (!choice) {
    return {
      id: resp.id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: resp.usage?.prompt_tokens ?? 0,
        output_tokens: resp.usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as BetaMessage
  }

  const content: BetaContentBlock[] = []

  // Reasoning content → thinking block
  // Check both `reasoning_content` (OpenAI) and `reasoning` (OpenRouter)
  const reasoning =
    (choice.message as any).reasoning_content ??
    (choice.message as any).reasoning ??
    null
  if (reasoning) {
    content.push({
      type: 'thinking',
      thinking: reasoning,
      signature: 'openai-compat',
    } as BetaContentBlock)
  }

  // Text → text block
  if (choice.message.content) {
    // Handle think tags in non-streaming mode
    let textContent = choice.message.content
    const thinkMatch = textContent.match(
      /^<think>([\s\S]*?)<\/think>([\s\S]*)$/,
    )
    if (thinkMatch) {
      content.push({
        type: 'thinking',
        thinking: thinkMatch[1]!,
        signature: 'openai-compat',
      } as BetaContentBlock)
      textContent = thinkMatch[2]!
    }
    if (textContent) {
      content.push({ type: 'text', text: textContent } as BetaContentBlock)
    }
  }

  // Tool calls → tool_use blocks
  for (const tc of choice.message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: safeJsonParse(tc.function.arguments),
    } as BetaContentBlock)
  }

  const stopReason: BetaStopReason =
    choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call'
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn'

  return {
    id: resp.id,
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as BetaMessage
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str || '{}')
  } catch {
    return { raw: str }
  }
}

async function collectStreamToBetaMessage(
  stream: AsyncIterable<BetaRawMessageStreamEvent>,
  fallbackModel: string,
): Promise<BetaMessage> {
  let message: BetaMessage | null = null
  let usage: BetaMessage['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  let stopReason: BetaStopReason | null = null
  const content: Array<BetaContentBlock | undefined> = []
  const pendingBlocks = new Map<
    number,
    {
      block: Record<string, any>
      partialJson?: string
    }
  >()

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        usage = {
          input_tokens: event.message.usage.input_tokens ?? 0,
          output_tokens: event.message.usage.output_tokens ?? 0,
          cache_creation_input_tokens:
            event.message.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens:
            event.message.usage.cache_read_input_tokens ?? 0,
        }
        message = {
          ...event.message,
          model: event.message.model ?? fallbackModel,
          content: [],
          usage,
        } as BetaMessage
        break
      }

      case 'content_block_start': {
        const block = event.content_block as Record<string, any>
        const entry =
          block.type === 'tool_use'
            ? {
                block: {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: {},
                  ...(block.response_item_id
                    ? { response_item_id: block.response_item_id }
                    : {}),
                },
                partialJson: '',
              }
            : {
                block: { ...block },
              }
        pendingBlocks.set(event.index, entry)
        content[event.index] = entry.block as BetaContentBlock
        break
      }

      case 'content_block_delta': {
        const entry = pendingBlocks.get(event.index)
        if (!entry) break

        if (
          entry.block.type === 'text' &&
          event.delta.type === 'text_delta'
        ) {
          entry.block.text = `${entry.block.text ?? ''}${event.delta.text ?? ''}`
        } else if (
          entry.block.type === 'thinking' &&
          event.delta.type === 'thinking_delta'
        ) {
          entry.block.thinking = `${entry.block.thinking ?? ''}${event.delta.thinking ?? ''}`
        } else if (
          entry.block.type === 'tool_use' &&
          event.delta.type === 'input_json_delta'
        ) {
          entry.partialJson = `${entry.partialJson ?? ''}${event.delta.partial_json ?? ''}`
        }
        break
      }

      case 'content_block_stop': {
        const entry = pendingBlocks.get(event.index)
        if (!entry) break

        if (entry.block.type === 'tool_use') {
          entry.block.input = safeJsonParse(entry.partialJson ?? '')
        }
        content[event.index] = entry.block as BetaContentBlock
        break
      }

      case 'message_delta': {
        stopReason = event.delta.stop_reason ?? stopReason
        usage = {
          input_tokens: event.usage.input_tokens ?? usage.input_tokens,
          output_tokens: event.usage.output_tokens ?? usage.output_tokens,
          cache_creation_input_tokens:
            event.usage.cache_creation_input_tokens ??
            usage.cache_creation_input_tokens,
          cache_read_input_tokens:
            event.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
        }
        break
      }
    }
  }

  if (!message) {
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: fallbackModel,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    } as BetaMessage
  }

  return {
    ...message,
    content: content.filter(Boolean) as BetaContentBlock[],
    stop_reason: stopReason ?? message.stop_reason ?? 'end_turn',
    stop_sequence: message.stop_sequence ?? null,
    usage,
  } as BetaMessage
}

// ─── Promise wrapper with .withResponse() ────────────────────────────────────

type PromiseWithResponse = Promise<any> & {
  withResponse(): Promise<{
    data: any
    request_id: string | null
    transport_info?: ResponsesTransportSummary
    response: Response | { headers: Headers }
  }>
}

function makePromiseWithResponse(
  inner: Promise<any>,
  responseInfoPromise?: Promise<{
    request_id: string | null
    transport_info?: ResponsesTransportSummary
    response: { headers: Headers }
  }>,
): PromiseWithResponse {
  const p = inner as PromiseWithResponse
  p.withResponse = async () => {
    if (responseInfoPromise) {
      const [data, responseInfo] = await Promise.all([inner, responseInfoPromise])
      return {
        data,
        request_id: responseInfo.request_id,
        transport_info: responseInfo.transport_info,
        response: responseInfo.response,
      }
    }

    const data = await inner
    return {
      data,
      request_id: null,
      transport_info: undefined,
      response: new Response(null, { status: 200 }),
    }
  }
  return p
}
