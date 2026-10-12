import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  AzureOpenAI,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError
} from 'openai'

/** An Azure OpenAI deployment in Azure AI Foundry, set in Settings or through AI_FOUNDRY_* variables. */
export interface AiConfig {
  endpoint: string
  deployment: string
  apiVersion: string
  apiKey: string
}

// The SDK wants the resource URL. Accept a full request URL too, like the AI_FOUNDRY_URL values
// that end in /openai/responses?api-version=..., and keep only its origin.
function resourceUrl(endpoint: string): string {
  try {
    return new URL(endpoint).origin
  } catch {
    return endpoint
  }
}

const INSTRUCTIONS = `You are the inline autocomplete engine inside a PostgreSQL query editor. The user is writing SQL and you predict the text they will type next at <cursor/>.

How to answer:
- Reply with only the exact text to insert at the cursor. No explanations, no markdown, no code fences.
- Never repeat text that is already before the cursor, and never duplicate text that already follows it.
- Use only tables, columns, types and enum values that exist in the database schema below. Schema-qualify names outside "public".
- Match the user's style: keyword casing, indentation, aliases, and whether statements end with semicolons.
- ":name" and "$1" are query variables the editor fills in at run time. Keep the ones the user wrote, and use the ":name" form if the user is already using variables.
- If the cursor follows a comment that describes a query, write that query, starting on a new line.
- Keep it short: finish the current clause or statement, at most about 12 lines.
- If nothing useful fits, reply with an empty message.

The database schema:
`

const MAX_PREFIX = 6000
const MAX_SUFFIX = 2000

/** Trims what the model repeated from around the cursor and any formatting it added. */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string | null {
  let text = raw.replace(/^\s*```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '')
  text = text.replace(/<cursor\s*\/>/g, '')

  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (line.trim().length >= 3) {
    if (text.startsWith(line)) text = text.slice(line.length)
    else if (text.startsWith(line.trimStart())) text = text.slice(line.trimStart().length)
  }
  // The model often restates the partial word at the cursor: "us" + "users ..." -> "ers ...".
  const word = /[A-Za-z0-9_.]+$/.exec(prefix)?.[0]
  if (word && text.startsWith(word) && text.length > word.length) text = text.slice(word.length)

  const nextLine = suffix.split('\n')[0].trim()
  if (nextLine && text.trimEnd().endsWith(nextLine)) text = text.trimEnd().slice(0, -nextLine.length)

  text = text.replace(/\s+$/, '')
  return text.trim() ? text : null
}

export class AiCompleter {
  private client: AzureOpenAI | null = null
  private clientKey: string | null = null
  private inflight = new Map<string, AbortController>()

  constructor(private config: () => AiConfig | null) {}

  private getClient(config: AiConfig): AzureOpenAI {
    const key = JSON.stringify(config)
    if (!this.client || key !== this.clientKey) {
      this.client = new AzureOpenAI({
        apiKey: config.apiKey,
        endpoint: resourceUrl(config.endpoint),
        deployment: config.deployment,
        apiVersion: config.apiVersion,
        maxRetries: 1
      })
      this.clientKey = key
    }
    return this.client
  }

  private async send(system: string, content: string, signal?: AbortSignal): Promise<string> {
    const config = this.config()
    if (!config) throw new Error('AI is not set up: add the Azure endpoint, deployment and API key in Settings.')
    // Azure caches repeated prompt prefixes by itself, so the schema goes first, in the system message.
    const response = await this.getClient(config).responses.create(
      {
        model: config.deployment,
        reasoning: { effort: 'low' },
        max_output_tokens: 4096,
        input: [
          { role: 'system', content: system },
          { role: 'user', content }
        ]
      },
      { signal }
    )
    return response.output_text
  }

  async complete(requestId: string, schemaText: string, prefix: string, suffix: string): Promise<string | null> {
    const controller = new AbortController()
    this.inflight.set(requestId, controller)
    try {
      const before = prefix.slice(-MAX_PREFIX)
      const after = suffix.slice(0, MAX_SUFFIX)
      const content = `<editor>\n${before}<cursor/>${after}\n</editor>`
      const text = await this.send(INSTRUCTIONS + schemaText, content, controller.signal)
      return cleanCompletion(text, before, after)
    } catch (e) {
      if (controller.signal.aborted || e instanceof APIUserAbortError) return null
      throw e
    } finally {
      this.inflight.delete(requestId)
    }
  }

  cancel(requestId: string) {
    this.inflight.get(requestId)?.abort()
  }

  async test(): Promise<string> {
    const text = await this.send('Reply with the single word OK.', 'Are you there?')
    return text.trim() || 'OK'
  }
}

export function describeAiError(e: unknown): string {
  if (e instanceof AuthenticationError) return 'The Azure API key was rejected.'
  if (e instanceof PermissionDeniedError) return 'This API key cannot use the deployment.'
  if (e instanceof NotFoundError) return 'Deployment not found. Check the endpoint and deployment name in Settings.'
  if (e instanceof RateLimitError) return 'Rate limited by Azure. Try again shortly.'
  if (e instanceof APIConnectionError) return 'Could not reach the Azure endpoint.'
  if (e instanceof APIError) return `Azure OpenAI error ${e.status ?? ''}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}
