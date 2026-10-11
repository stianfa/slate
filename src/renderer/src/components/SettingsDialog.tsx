import { useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { AI_MODELS, type TestResult, type Theme } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Dialog, Field, Spinner } from './ui'

const ROW_LIMITS = [100, 500, 1000, 5000, 10000, 50000]

export function SettingsDialog() {
  const settings = useStore((s) => s.settings)!
  const saveSettings = useStore((s) => s.saveSettings)
  const setDialog = useStore((s) => s.setDialog)
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<TestResult | 'running' | null>(null)

  const close = () => setDialog(null)

  const saveKey = async () => {
    if (!apiKey.trim()) return
    await saveSettings({ apiKey: apiKey.trim() })
    setApiKey('')
    setTest('running')
    setTest(await api.testAi())
  }

  return (
    <Dialog title="Settings" onClose={close} width={500}>
      <div className="form">
        <section className="settings-section">
          <h3>AI autocomplete</h3>
          <p className="muted small">
            Suggests the rest of your query as you type, using the tables and columns of the database the tab is connected
            to. Only the schema and the text around your cursor are sent to Anthropic, never row data.
          </p>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => void saveSettings({ aiEnabled: e.target.checked })}
            />
            <span>Enable inline suggestions</span>
          </label>
          <Field
            label="Anthropic API key"
            hint={
              settings.apiKeySource === 'settings'
                ? 'A key is saved (encrypted with your OS keychain).'
                : settings.apiKeySource === 'env'
                  ? 'Using ANTHROPIC_API_KEY from the environment.'
                  : 'Create one at console.anthropic.com.'
            }
          >
            <div className="input-row">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
                placeholder={settings.apiKeySource === 'settings' ? '••••••••••••••••' : 'sk-ant-…'}
                spellCheck={false}
              />
              <button className="btn" onClick={() => void saveKey()} disabled={!apiKey.trim()}>
                Save
              </button>
              {settings.apiKeySource === 'settings' && (
                <button className="btn" onClick={() => void saveSettings({ apiKey: null })}>
                  Remove
                </button>
              )}
            </div>
          </Field>
          <Field label="Model">
            <select value={settings.aiModel} onChange={(e) => void saveSettings({ aiModel: e.target.value })}>
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="input-row">
            <button
              className="btn"
              onClick={async () => {
                setTest('running')
                setTest(await api.testAi())
              }}
              disabled={!settings.apiKeySource || test === 'running'}
            >
              Test AI
            </button>
            <div className="test-result">
              {test === 'running' && <Spinner />}
              {test && test !== 'running' && (
                <span className={test.ok ? 'ok' : 'bad'}>
                  {test.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {test.message}
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>Queries</h3>
          <Field label="Row limit" hint="Results stop after this many rows so huge tables stay fast.">
            <select value={settings.rowLimit} onChange={(e) => void saveSettings({ rowLimit: Number(e.target.value) })}>
              {ROW_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString('en-US')} rows
                </option>
              ))}
            </select>
          </Field>
        </section>

        <section className="settings-section">
          <h3>Environment variables</h3>
          <p className="muted small">
            Values for query variables like <span className="mono">:tenant_id</span>, set per environment. A tab picks the
            values for the environment its database is marked with.
          </p>
          <div className="input-row">
            <button className="btn" onClick={() => setDialog({ type: 'envVariables' })}>
              Edit environment variables
            </button>
            <span className="muted small">
              {(() => {
                const names = new Set(Object.values(settings.environmentVariables).flatMap((v) => Object.keys(v ?? {})))
                return names.size ? `${names.size} defined` : 'None yet'
              })()}
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="segmented">
            {(['system', 'dark', 'light'] as Theme[]).map((t) => (
              <button
                key={t}
                className={settings.theme === t ? 'active' : ''}
                onClick={() => void saveSettings({ theme: t })}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  )
}
