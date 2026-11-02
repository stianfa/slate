import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig, ConnectionInput, EnvironmentVariables, Settings, SettingsInput, Theme } from '@shared/types'
import { DEFAULT_AI_API_VERSION, withRenamedEnvironments, withRenamedEnvironmentVariables } from '@shared/types'
import type { AiConfig } from './ai'
import type { ResolvedConnection } from './db'

interface StoredConnection extends Omit<ConnectionConfig, 'hasPassword'> {
  password?: string
}

interface StoredSettings {
  aiEnabled: boolean
  aiEndpoint: string
  aiDeployment: string
  aiApiVersion: string
  rowLimit: number
  theme: Theme
  environmentVariables: EnvironmentVariables
  aiApiKey?: string
}

const DEFAULT_SETTINGS: StoredSettings = {
  aiEnabled: true,
  aiEndpoint: '',
  aiDeployment: '',
  aiApiVersion: '',
  rowLimit: 1000,
  theme: 'system',
  environmentVariables: {}
}

// Secrets are encrypted with the OS keychain (DPAPI on Windows) when available.
function seal(secret: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(secret).toString('base64')
  return 'raw:' + Buffer.from(secret, 'utf8').toString('base64')
}

function unseal(value: string | undefined): string | null {
  if (!value) return null
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8')
  } catch {
    // Encrypted by another user or machine.
  }
  return null
}

// macOS only lets the app that sealed a secret unseal it, and each Slate build is ad-hoc signed,
// so after an update the keychain can refuse the old secrets.
function savedPassword(stored: StoredConnection): string | null {
  const password = unseal(stored.password)
  if (stored.password && password === null) {
    throw new Error(
      `Slate couldn't read the saved password for ${stored.name} from the macOS keychain. This happens after installing a new Slate build, because macOS treats it as a different app. Quit and reopen Slate and choose Always Allow when macOS asks about "Slate Safe Storage", or open Edit connection and type the password again.`
    )
  }
  return password
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function readSettings(file: string): StoredSettings {
  const settings: StoredSettings & { aiModel?: string; apiKey?: string } = { ...DEFAULT_SETTINGS, ...readJson(file, {}) }
  // An Anthropic model and key from before the switch to Azure OpenAI; they don't apply anymore.
  delete settings.aiModel
  delete settings.apiKey
  return { ...settings, environmentVariables: withRenamedEnvironmentVariables(settings.environmentVariables ?? {}) }
}

// Environment variables for dev runs and setups without Settings.
const env = (name: string) => process.env[name]?.trim() || ''

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export class Store {
  private connectionsFile = join(app.getPath('userData'), 'connections.json')
  private settingsFile = join(app.getPath('userData'), 'settings.json')
  private workspaceFile = join(app.getPath('userData'), 'workspace.json')
  private connections: StoredConnection[] = readJson<StoredConnection[]>(this.connectionsFile, []).map(withRenamedEnvironments)
  private settings: StoredSettings = readSettings(this.settingsFile)

  listConnections(): ConnectionConfig[] {
    return this.connections.map(({ password, ...c }) => ({ ...c, hasPassword: Boolean(password) }))
  }

  saveConnection(input: ConnectionInput): ConnectionConfig {
    const existing = input.id ? this.connections.find((c) => c.id === input.id) : undefined
    const { password, name, color, host, port, user, database, ssl, environment, databaseEnvironments } = input
    const next: StoredConnection = {
      id: existing?.id ?? randomUUID(),
      name,
      color,
      host,
      port,
      user,
      database,
      ssl,
      environment,
      databaseEnvironments,
      password: password === undefined ? existing?.password : password ? seal(password) : undefined
    }
    this.connections = existing
      ? this.connections.map((c) => (c.id === next.id ? next : c))
      : [...this.connections, next]
    writeJson(this.connectionsFile, this.connections)
    return this.listConnections().find((c) => c.id === next.id)!
  }

  deleteConnection(id: string) {
    this.connections = this.connections.filter((c) => c.id !== id)
    writeJson(this.connectionsFile, this.connections)
  }

  resolve(id: string): ResolvedConnection {
    const stored = this.connections.find((c) => c.id === id)
    if (!stored) throw new Error('Connection not found.')
    const { password, ...config } = stored
    return { config: { ...config, hasPassword: Boolean(password) }, password: savedPassword(stored) }
  }

  /** Password for a test run of an edited connection: the typed one, else the stored one. */
  passwordFor(input: ConnectionInput): string | null {
    if (input.password !== undefined) return input.password || null
    const stored = input.id ? this.connections.find((c) => c.id === input.id) : undefined
    return stored ? savedPassword(stored) : null
  }

  getSettings(): Settings {
    const { aiApiKey, ...rest } = this.settings
    return {
      ...rest,
      aiFallback: {
        endpoint: env('AI_FOUNDRY_URL'),
        deployment: env('AI_FOUNDRY_MODEL'),
        apiVersion: env('AI_FOUNDRY_API_VERSION') || DEFAULT_AI_API_VERSION
      },
      aiKeySource: aiApiKey ? (unseal(aiApiKey) ? 'settings' : 'unreadable') : env('AI_FOUNDRY_API_KEY') ? 'env' : null,
      aiReady: this.aiConfig() !== null
    }
  }

  saveSettings(input: SettingsInput): Settings {
    const { aiApiKey, ...rest } = input
    const next: StoredSettings = { ...this.settings, ...rest }
    for (const key of ['aiEndpoint', 'aiDeployment', 'aiApiVersion'] as const) next[key] = next[key].trim()
    if (aiApiKey !== undefined) next.aiApiKey = aiApiKey ? seal(aiApiKey.trim()) : undefined
    this.settings = next
    writeJson(this.settingsFile, next)
    return this.getSettings()
  }

  loadWorkspace(): string | null {
    try {
      return readFileSync(this.workspaceFile, 'utf8')
    } catch {
      return null
    }
  }

  /** Written to a temporary file first, so a crash mid-write never leaves half a workspace. */
  saveWorkspace(json: string) {
    JSON.parse(json)
    const tmp = `${this.workspaceFile}.tmp`
    writeFileSync(tmp, json)
    renameSync(tmp, this.workspaceFile)
  }

  /** Settings win over the AI_FOUNDRY_* variables, field by field. Null until endpoint, deployment and key are set. */
  aiConfig(): AiConfig | null {
    const s = this.settings
    const endpoint = s.aiEndpoint || env('AI_FOUNDRY_URL')
    const deployment = s.aiDeployment || env('AI_FOUNDRY_MODEL')
    const apiVersion = s.aiApiVersion || env('AI_FOUNDRY_API_VERSION') || DEFAULT_AI_API_VERSION
    const apiKey = unseal(s.aiApiKey) || env('AI_FOUNDRY_API_KEY')
    return endpoint && deployment && apiKey ? { endpoint, deployment, apiVersion, apiKey } : null
  }

  aiEnabled(): boolean {
    return this.settings.aiEnabled
  }
}
