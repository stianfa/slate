import type { CSSProperties } from 'react'
import { environmentOf, ENVIRONMENTS, type Target } from '@shared/types'
import { useStore } from '../store'

export type EnvironmentInfo = (typeof ENVIRONMENTS)[number]

/** The environment the target database is marked with, or null. */
export function useEnvironment(target: Target | null | undefined): EnvironmentInfo | null {
  return useStore((s) =>
    target ? environmentOf(s.connections.find((c) => c.id === target.connectionId), target.database) : null
  )
}

export const envStyle = (env: EnvironmentInfo | null) => (env ? ({ '--env': env.color } as CSSProperties) : undefined)

export function EnvBadge({ env, long = false }: { env: EnvironmentInfo; long?: boolean }) {
  return (
    <span className={`env-badge ${env.id}`} style={envStyle(env)} title={`${env.label} environment`}>
      {long ? env.label : env.short}
    </span>
  )
}

/** Colored strip across the top of a tab's content. */
export function EnvStrip({ env }: { env: EnvironmentInfo | null }) {
  return env ? <div className={`env-strip ${env.id}`} style={envStyle(env)} /> : null
}
