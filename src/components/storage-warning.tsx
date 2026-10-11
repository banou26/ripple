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
 * answered, the ask is gone for the session.
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
        {getHumanReadableByteString(storage.usedBytes, true)} of {getHumanReadableByteString(storage.limitBytes, true)} used
      </span>
      {/* First, because it is the only route that can raise the limit. It renders nothing where there
          is nothing to ask for. */}
      <PersistOffer persist={persist} onAsk={onAskPersist}/>
      {offer.detail && <span>{offer.detail}</span>}
      {offer.action && <button type="button" onClick={onAct}>{offer.action}</button>}
    </div>
  )
}
