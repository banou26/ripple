import { Film } from 'lucide-react'
import { useRef } from 'react'

/**
 * The first-run offer of a sample torrent, drawn as a row of the list it would join.
 *
 * Deliberately NOT a `.torrent`: the end-to-end specs count and click rows by that class. Answered
 * once: the ref drops a second press landing before the re-render that takes the row away.
 */
export const SampleOffer = ({ onAnswer }: {
  /** True adds the sample. */
  onAnswer: (add: boolean) => void
}) => {
  const answered = useRef(false)

  const answer = (add: boolean) => {
    if (answered.current) return
    answered.current = true
    onAnswer(add)
  }

  return (
    <div className="sample surface">
      <div className="poster placeholder"><Film aria-hidden="true"/></div>
      <div className="content">
        <div className="main">
          <div className="body">
            <div className="title"><strong>Try Ripple with Sintel, a free open movie (129 MB)</strong></div>
          </div>
          <div className="side">
            <div className="actions">
              <button type="button" onClick={() => answer(true)}>Add Sintel</button>
              <button type="button" onClick={() => answer(false)}>No thanks</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
