import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type OpenAI from 'openai'

type ChatMessage = OpenAI.ChatCompletionMessageParam
type ChatTool = OpenAI.ChatCompletionTool

// ─── System prompt ───────────────────────────────────────────────────────────

export function translateSystemPrompt(
  system: Array<TextBlockParam & { cache_control?: unknown }> | string | undefined,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map((b) => b.text).join('\n\n')
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function translateMessages(
  messages: BetaMessageParam[],
): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push(...translateUserMessage(msg))
    } else if (msg.role === 'assistant') {
      result.push(...translateAssistantMessage(msg))
    }
  }
  return result
}

function translateUserMessage(
  msg: BetaMessageParam,
): ChatMessage[] {
  const content = msg.content
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }

  const textParts: OpenAI.ChatCompletionContentPart[] = []
  const toolResults: ChatMessage[] = []

  for (const block of content as BetaContentBlockParam[]) {
    const b = block as Record<string, any>
    switch (b.type) {
      case 'text':
        textParts.push({ type: 'text', text: b.text })
        break
      case 'image': {
        const src = b.source
        if (src?.type === 'base64') {
          textParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${src.media_type};base64,${src.data}`,
            },
          })
        } else if (src?.type === 'url') {
          textParts.push({
            type: 'image_url',
            image_url: { url: src.url },
          })
        }
        break
      }
      case 'tool_result':
        toolResults.push(translateToolResult(b as BetaToolResultBlockParam))
        break
      // document, cache_control etc. → silently skip
    }
  }

  // Tool results must appear immediately after the assistant's tool_calls message.
  // If we put user text before tool results, it breaks the OpenAI API's required
  // message ordering: assistant(tool_calls) → tool(result) → user(text).
  const result: ChatMessage[] = [...toolResults]
  if (textParts.length > 0) {
    // Simplify single text part to plain string
    if (textParts.length === 1 && textParts[0]!.type === 'text') {
      result.push({ role: 'user', content: (textParts[0] as any).text })
    } else {
      result.push({ role: 'user', content: textParts })
    }
  }
  return result
}

function translateToolResult(
  block: BetaToolResultBlockParam,
): ChatMessage {
  let content: string
  if (typeof block.content === 'string') {
    content = block.content
  } else if (Array.isArray(block.content)) {
    content = block.content
      .map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n')
  } else {
    content = block.content ? String(block.content) : ''
  }

  // If tool returned an error, prepend error marker
  if (block.is_error) {
    content = `[ERROR] ${content}`
  }

  return {
    role: 'tool' as const,
    tool_call_id: block.tool_use_id,
    content,
  }
}

function translateAssistantMessage(
  msg: BetaMessageParam,
): ChatMessage[] {
  const content = msg.content
  if (typeof content === 'string') {
    return [{ role: 'assistant', content }]
  }

  let textContent = ''
  let reasoningContent = ''
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []

  for (const block of content as BetaContentBlockParam[]) {
    const b = block as Record<string, any>
    switch (b.type) {
      case 'text':
        textContent += b.text
        break
      case 'tool_use':
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments:
              typeof b.input === 'string'
                ? b.input
                : JSON.stringify(b.input ?? {}),
          },
        })
        break
      case 'thinking':
        reasoningContent += b.thinking ?? ''
        break
      // redacted_thinking, signature → silently drop
    }
  }

  return [
    {
      role: 'assistant',
      content: textContent || null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      ...(reasoningContent && { reasoning_content: reasoningContent }),
    } as ChatMessage,
  ]
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export function translateTools(
  tools: BetaToolUnion[] | undefined,
): ChatTool[] | undefined {
  if (!tools?.length) return undefined
  return tools
    .filter((t: any) => !t.type || t.type === 'custom')
    .map((t: any) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema as Record<string, unknown>,
      },
    }))
}

// ─── Tool choice ─────────────────────────────────────────────────────────────

export function translateToolChoice(
  choice: unknown,
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined
  const c = choice as Record<string, any>
  switch (c.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return {
        type: 'function',
        function: { name: c.name },
      }
    case 'none':
      return 'none'
    default:
      return undefined
  }
}
