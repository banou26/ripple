import type { PersistState } from '../torrent/storage-permission'

import { useRef, useState } from 'react'

import { persistControl } from '../torrent/storage-permission'

import { hint } from './hint'

/**
 * The footer's standing control for persistent storage, beside Speed, On add and Auto-save.
 *
 * WHY IT EXISTS BESIDE `PersistOffer`. That one is an offer inside a notice, so it appears only when
 * something is already wrong and says nothing in the states where there is nothing to ask for. This
 * one is a control: it is always present, it reports its state whether or not anything is wrong, and
 * it is where somebody goes who wants the prompt NOW rather than when a download is already too big
 * to fit. Every word still comes from `persistControl`, so the two cannot describe the same call
 * differently.
 *
 * DISABLED RATHER THAN HIDDEN in the three states that cannot raise a prompt (already persistent,
 * blocked in the browser's own settings, or asked and answered no this session). A control that
 * disappears once it has been answered sends somebody hunting through browser settings for a switch
 * that is simply already decided, and the hint on the disabled button is where that answer lives.
 *
 * The one-press latch is a ref as well as state, for the reason measured in `PersistOffer`: two
 * clicks in the same tick both reach the handler, because React has not re-rendered the button as
 * disabled by the time the second arrives, so `disabled` alone would still allow a second prompt.
 *
 * No styles of its own. The footer's `.folder` group paints it, exactly as it paints the others.
 */
export const PersistControl = ({ persist, onAsk }: {
  persist: PersistState
  /** Makes the ask. Never rejects: `usePersistentStorage().request` catches everything itself. */
  onAsk: () => void
}) => {
  const asked = useRef(false)
  const [pressed, setPressed] = useState(false)
  const control = persistControl(persist)

  const ask = () => {
    if (asked.current) return
    asked.current = true
    setPressed(true)
    onAsk()
  }

  return (
    <div className="folder">
      <span>Storage</span>
      <button
        type="button"
        className={control.on ? 'on' : undefined}
        disabled={!control.actionable || pressed}
        onClick={ask}
        {...hint(control.hint)}
      >
        {control.label}
      </button>
    </div>
  )
}
