import Anthropic from '@anthropic-ai/sdk'

// Models that take server-side refusal fallbacks ("default" routes by refusal category).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

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
  private client: Anthropic | null = null
  private clientKey: string | null = null
  private inflight = new Map<string, AbortController>()

  constructor(
    private apiKey: () => string | null,
    private model: () => string
  ) {}

  private getClient(): Anthropic {
    const key = this.apiKey()
    if (!this.client || key !== this.clientKey) {
      // Without a key the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
      this.client = new Anthropic(key ? { apiKey: key, maxRetries: 1 } : { maxRetries: 1 })
      this.clientKey = key
    }
    return this.client
  }

  private async send(
    system: Anthropic.TextBlockParam[],
    content: string,
    signal?: AbortSignal
  ): Promise<{ text: string; refused: boolean }> {
    const model = this.model()
    const params = {
      model,
      max_tokens: 4096,
      output_config: { effort: 'low' as const },
      system,
      messages: [{ role: 'user' as const, content }]
    }
    const client = this.getClient()
    const response = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal }
        )
      : await client.messages.create(params, { signal })
    if (response.stop_reason === 'refusal') return { text: '', refused: true }
    let text = ''
    for (const block of response.content) if (block.type === 'text') text += block.text
    return { text, refused: false }
  }

  async complete(requestId: string, schemaText: string, prefix: string, suffix: string): Promise<string | null> {
    const controller = new AbortController()
    this.inflight.set(requestId, controller)
    try {
      const before = prefix.slice(-MAX_PREFIX)
      const after = suffix.slice(0, MAX_SUFFIX)
      const system: Anthropic.TextBlockParam[] = [
        // The schema rarely changes between keystrokes, so it is cached.
        { type: 'text', text: INSTRUCTIONS + schemaText, cache_control: { type: 'ephemeral' } }
      ]
      const content = `<editor>\n${before}<cursor/>${after}\n</editor>`
      const { text } = await this.send(system, content, controller.signal)
      return cleanCompletion(text, before, after)
    } catch (e) {
      if (controller.signal.aborted || e instanceof Anthropic.APIUserAbortError) return null
      throw e
    } finally {
      this.inflight.delete(requestId)
    }
  }

  cancel(requestId: string) {
    this.inflight.get(requestId)?.abort()
  }

  async test(): Promise<string> {
    const { text, refused } = await this.send(
      [{ type: 'text', text: 'Reply with the single word OK.' }],
      'Are you there?'
    )
    if (refused) throw new Error('The model declined the test request.')
    return text.trim() || 'OK'
  }
}

export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected.'
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use the selected model.'
  if (e instanceof Anthropic.NotFoundError) return 'The selected model was not found.'
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Try again shortly.'
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.'
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}
