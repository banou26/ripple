/*
 * Launch arguments that leave Chrome's storage partitioning on, as a person's browser has it. Playwright turns
 * it off, and a spec about what a framed page keeps would then pass for the wrong reason. This is playwright's
 * feature list for 1.61 less the one wanted back: if it drifts, the partition control of each spec that spreads
 * these fails first.
 */
const PLAYWRIGHT_OFF = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'BoundaryEventDispatchTracksNodeRemoval', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'RenderDocument', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']

export const PARTITIONED = {
  args: [`--disable-features=${PLAYWRIGHT_OFF.filter((feature) => feature !== 'ThirdPartyStoragePartitioning').join(',')}`],
  ignoreDefaultArgs: [`--disable-features=${PLAYWRIGHT_OFF.join(',')}`],
}
