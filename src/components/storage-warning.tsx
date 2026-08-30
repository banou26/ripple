import type { StorageRelief } from '../torrent/storage-relief'
import type { StorageUsage } from '../torrent/use-storage-usage'

import { reliefOffer } from '../torrent/storage-relief'
import { getHumanReadableByteString } from '../utils/bytes'

/**
 * The notice that the origin is filling up, and the one thing that can be done about it.
 *
 * NO STYLES OF ITS OWN, unlike the other extracted pieces here. `.storage-warning` lives in home's
 * stylesheet and is shared with the "downloads hit a problem" notice, so moving it would take that
 * one's appearance with it. This is extracted purely so the WIRING can be measured: which button
 * appears, and that pressing it calls back. A test of that does not need the paint.
 *
 * `role=status` and not `alert`: the browser's budget drifts on its own, so this can appear and
 * clear again without anybody doing anything.
 */
export const StorageWarning = ({ storage, relief, onAct }: {
  storage: StorageUsage
  relief: StorageRelief
  /** Runs the action `relief` describes. The component deliberately does not know which that is. */
  onAct: () => void
}) => {
  const offer = reliefOffer(relief)
  return (
    <div className="storage-warning surface" role="status">
      <strong>Running out of room</strong>
      <span>
        Ripple has used {getHumanReadableByteString(storage.usedBytes, true)} of the
        {' '}{getHumanReadableByteString(storage.limitBytes, true)} your browser allows this
        site, counting everything it keeps here. Downloads stop when that runs out.
        {' '}{offer.detail}
        {!storage.persisted && ' Storage here is best effort, so the browser can also clear it on its own when the device gets tight.'}
      </span>
      {/* The way out, in the place the problem is reported. This used to say only "removing a
          torrent frees its files", which is true, and points at deleting your library. */}
      {offer.action && <button type="button" onClick={onAct}>{offer.action}</button>}
    </div>
  )
}
