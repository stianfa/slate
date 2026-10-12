import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { DEFAULT_AI_API_VERSION, type TestResult, type Theme } from '@shared/types'
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
    await saveSettings({ aiApiKey: apiKey.trim() })
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
            to. Suggestions come from an Azure OpenAI deployment in Azure AI Foundry. Only the schema and the text around
            your cursor are sent, never row data.
          </p>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => void saveSettings({ aiEnabled: e.target.checked })}
            />
            <span>Enable inline suggestions</span>
          </label>
          <TextSetting
            label="Endpoint"
            value={settings.aiEndpoint}
            fallback={settings.aiFallback.endpoint}
            envName="AI_FOUNDRY_URL"
            placeholder="https://your-resource.cognitiveservices.azure.com"
            hint="The Azure resource URL. A full request URL works too; only the part up to the host name is used."
            onSave={(aiEndpoint) => void saveSettings({ aiEndpoint })}
          />
          <TextSetting
            label="Deployment"
            value={settings.aiDeployment}
            fallback={settings.aiFallback.deployment}
            envName="AI_FOUNDRY_MODEL"
            placeholder="deployment name"
            hint="The name of the model deployment in Azure AI Foundry."
            onSave={(aiDeployment) => void saveSettings({ aiDeployment })}
          />
          <TextSetting
            label="API version"
            value={settings.aiApiVersion}
            fallback={settings.aiFallback.apiVersion}
            envName="AI_FOUNDRY_API_VERSION"
            placeholder={settings.aiFallback.apiVersion}
            onSave={(aiApiVersion) => void saveSettings({ aiApiVersion })}
          />
          <Field
            label="API key"
            hint={
              settings.aiKeySource === 'settings'
                ? 'A key is saved (encrypted with your OS keychain).'
                : settings.aiKeySource === 'env'
                  ? 'Using AI_FOUNDRY_API_KEY from the environment.'
                  : settings.aiKeySource === 'unreadable'
                    ? "The saved key can't be read by this Slate build (macOS treats each new build as a different app). Paste it again."
                    : 'A key for the Azure resource, from Azure AI Foundry under Keys and Endpoint.'
            }
          >
            <div className="input-row">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
                placeholder={settings.aiKeySource === 'settings' ? '••••••••••••••••' : 'API key'}
                spellCheck={false}
              />
              <button className="btn" onClick={() => void saveKey()} disabled={!apiKey.trim()}>
                Save
              </button>
              {(settings.aiKeySource === 'settings' || settings.aiKeySource === 'unreadable') && (
                <button className="btn" onClick={() => void saveSettings({ aiApiKey: null })}>
                  Remove
                </button>
              )}
            </div>
          </Field>
          <div className="input-row">
            <button
              className="btn"
              onClick={async () => {
                setTest('running')
                setTest(await api.testAi())
              }}
              disabled={!settings.aiReady || test === 'running'}
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
            Values for query variables like <span className="mono">:tenant_id</span>, set per environment or globally. A
            tab picks the values for the environment its database is marked with, plus the global ones.
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

/** A text setting saved when the field loses focus or Enter is pressed. Empty falls back to an AI_FOUNDRY_* variable. */
function TextSetting({
  label,
  value,
  fallback,
  envName,
  placeholder,
  hint,
  onSave
}: {
  label: string
  value: string
  fallback: string
  envName: string
  placeholder: string
  hint?: string
  onSave(value: string): void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => draft.trim() !== value && onSave(draft.trim())
  // The default API version isn't from the environment, so it only shows as the placeholder.
  const fromEnv = !value && fallback && fallback !== DEFAULT_AI_API_VERSION ? fallback : ''
  return (
    <Field label={label} hint={fromEnv ? `Using ${envName} from the environment.` : hint}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder={fromEnv || placeholder}
        spellCheck={false}
      />
    </Field>
  )
}
