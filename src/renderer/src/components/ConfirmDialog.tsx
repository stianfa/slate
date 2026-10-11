import { TriangleAlert } from 'lucide-react'
import { useStore } from '../store'
import { Dialog } from './ui'

/** Yes/no questions from the store's confirm(); Cancel is the default answer. */
export function ConfirmDialog() {
  const confirmation = useStore((s) => s.confirmation)
  if (!confirmation) return null
  const answer = confirmation.resolve

  return (
    <Dialog
      title={confirmation.title}
      onClose={() => answer(false)}
      width={480}
      footer={
        <>
          <div className="grow" />
          <button className="btn" onClick={() => answer(false)} autoFocus>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={() => answer(true)}>
            {confirmation.confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-run">
        <p>
          <TriangleAlert size={15} />
          <span>{confirmation.message}</span>
        </p>
      </div>
    </Dialog>
  )
}
