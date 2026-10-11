import { TriangleAlert } from 'lucide-react'
import { useStore } from '../store'
import { Dialog } from './ui'

const SHOWN = 5

/** Asks before statements that change data or schema run on a database marked Production. */
export function ConfirmRunDialog() {
  const pending = useStore((s) => s.pendingRun)
  const connection = useStore((s) => s.connections.find((c) => c.id === s.pendingRun?.target.connectionId))
  const confirmRun = useStore((s) => s.confirmRun)
  const cancelRun = useStore((s) => s.cancelRun)
  if (!pending) return null
  const count = pending.writes.length

  return (
    <Dialog
      title={pending.blocked ? 'Allow writes on production?' : 'Run on production?'}
      onClose={cancelRun}
      width={580}
      className="danger"
      footer={
        <>
          <div className="grow" />
          <button className="btn" onClick={cancelRun} autoFocus>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={confirmRun}>
            Run on production
          </button>
        </>
      }
    >
      <div className="confirm-run">
        <p>
          <TriangleAlert size={15} />
          {pending.blocked ? (
            <span>
              Postgres refused a write because production sessions are read-only ({pending.blocked}). Running again
              allows writes in{' '}
              <strong>
                {connection?.name} / {pending.target.database}
              </strong>{' '}
              for {count === 1 ? 'this statement' : `these ${count} statements`}.
            </span>
          ) : (
            <span>
              {count === 1 ? 'This statement changes' : `These ${count} statements change`} data or schema in{' '}
              <strong>
                {connection?.name} / {pending.target.database}
              </strong>
              , which is marked as Production.
            </span>
          )}
        </p>
        <div className="confirm-statements">
          {pending.writes.slice(0, SHOWN).map((w, i) => (
            <pre key={i}>{w.length > 500 ? `${w.slice(0, 500)}…` : w}</pre>
          ))}
          {count > SHOWN && <div className="muted small">and {count - SHOWN} more</div>}
        </div>
      </div>
    </Dialog>
  )
}
