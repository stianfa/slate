import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig, ConnectionInput, EnvironmentVariables, Settings, SettingsInput, Theme } from '@shared/types'
import type { ResolvedConnection } from './db'

interface StoredConnection extends Omit<ConnectionConfig, 'hasPassword'> {
  password?: string
}

interface StoredSettings {
  aiEnabled: boolean
  aiModel: string
  rowLimit: number
  theme: Theme
  environmentVariables: EnvironmentVariables
  apiKey?: string
}

const DEFAULT_SETTINGS: StoredSettings = {
  aiEnabled: true,
  aiModel: 'claude-opus-5-5',
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

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export class Store {
  private connectionsFile = join(app.getPath('userData'), 'connections.json')
  private settingsFile = join(app.getPath('userData'), 'settings.json')
  private connections: StoredConnection[] = readJson(this.connectionsFile, [])
  private settings: StoredSettings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) }

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
    return { config: { ...config, hasPassword: Boolean(password) }, password: unseal(password) }
  }

  /** Password for a test run of an edited connection: the typed one, else the stored one. */
  passwordFor(input: ConnectionInput): string | null {
    if (input.password !== undefined) return input.password || null
    const stored = input.id ? this.connections.find((c) => c.id === input.id) : undefined
    return unseal(stored?.password)
  }

  getSettings(): Settings {
    const { apiKey, ...rest } = this.settings
    return {
      ...rest,
      apiKeySource: apiKey ? 'settings' : process.env.ANTHROPIC_API_KEY ? 'env' : null
    }
  }

  saveSettings(input: SettingsInput): Settings {
    const { apiKey, ...rest } = input
    const next: StoredSettings = { ...this.settings, ...rest }
    if (apiKey !== undefined) next.apiKey = apiKey ? seal(apiKey.trim()) : undefined
    this.settings = next
    writeJson(this.settingsFile, next)
    return this.getSettings()
  }

  apiKey(): string | null {
    return unseal(this.settings.apiKey) ?? process.env.ANTHROPIC_API_KEY ?? null
  }

  aiModel(): string {
    return this.settings.aiModel
  }

  aiEnabled(): boolean {
    return this.settings.aiEnabled
  }
}
