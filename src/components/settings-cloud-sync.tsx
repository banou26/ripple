import { confirmPendingVpnOff, declinePendingVpnOff, useSettingsCloudSync } from '../torrent/settings-sync'
import { VpnSyncPrompt } from './vpn-switch'

export const SettingsCloudSync = () => {
  const pendingVpnOff = useSettingsCloudSync()
  if (!pendingVpnOff) return null
  return (
    <VpnSyncPrompt
      onAnswer={(off) => {
        void (off ? confirmPendingVpnOff() : declinePendingVpnOff())
      }}
    />
  )
}
