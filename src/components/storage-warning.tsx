import type { PersistState } from '../torrent/storage-permission'
import type { StorageRelief } from '../torrent/storage-relief'
import type { StorageUsage } from '../torrent/use-storage-usage'

import { reliefOffer } from '../torrent/storage-relief'
import { getHumanReadableByteString } from '../utils/bytes'

import { PersistOffer } from './persist-offer'

/**
 * The notice that the origin is filling up, and the two things that can be done about it.
 *
 * TWO ROUTES, NOT ONE, since 2026-09-01. Asking the browser for persistent storage comes first
 * because on Firefox it is the only route that moves the LIMIT rather than moving bytes out from
 * under it: granting that doorhanger took the reported quota from 12 GB to 3.97 TB on an 8.03 TB
 * device. It is offered first and not alone, because on Chromium the same call is refused without
 * anyone being asked, and there the folder is the whole of what can be done. Once the browser has
 * answered, its answer takes that first slot in place of the button.
 *
 * The two buttons must never read as one action, which is why neither label is written here: "Ask
 * for more room" comes from storage-permission.ts and the folder labels come from storage-relief.ts,
 * and both are pinned by their own tests.
 *
 * NO STYLES OF ITS OWN, unlike the other extracted pieces here. `.storage-warning` lives in home's
 * stylesheet and is shared with the "downloads hit a problem" notice, so moving it would take that
 * one's appearance with it. This is extracted purely so the WIRING can be measured: which button
 * appears, and that pressing it calls back. A test of that does not need the paint.
 *
 * `role=status` and not `alert`: the browser's budget drifts on its own, so this can appear and
 * clear again without anybody doing anything.
 */
export const StorageWarning = ({ storage, relief, onAct, persist, onAskPersist }: {
  storage: StorageUsage
  relief: StorageRelief
  /** Runs the action `relief` describes. The component deliberately does not know which that is. */
  onAct: () => void
  persist: PersistState
  /** Asks the browser for persistent storage. Runs on a press, never on a render. */
  onAskPersist: () => void
}) => {
  const offer = reliefOffer(relief)
  return (
    <div className="storage-warning surface" role="status">
      <strong>Running out of room</strong>
      <span>
        Ripple has used {getHumanReadableByteString(storage.usedBytes, true)} of the
        {' '}{getHumanReadableByteString(storage.limitBytes, true)} your browser allows this
        site, counting everything it keeps here. Downloads stop when that runs out.
        {!storage.persisted && ' Storage here is best effort, so the browser can also clear it on its own when the device gets tight.'}
      </span>
      {/* First, and above the folder, because it is the only route that can raise the number in the
          sentence above. It renders nothing at all where there is nothing to ask for. */}
      <PersistOffer persist={persist} onAsk={onAskPersist}/>
      {/* The way out that works on every engine, in the place the problem is reported. This used to
          say only "removing a torrent frees its files", which is true, and points at deleting your
          library. It stays on offer beside the ask above, and outlives it: the ask can be answered
          no, and moving bytes off the origin still works when it is. */}
      <span>{offer.detail}</span>
      {offer.action && <button type="button" onClick={onAct}>{offer.action}</button>}
    </div>
  )
}
