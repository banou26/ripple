// A stand-in for `@fkn/lib`'s `shell.isAppTab`: fkn.app's answer to whether this frame is the one its `/app` page
// mounted for ripple as its tab's own page, given when a test says. The lib answers once, false by its 8 s deadline.
let answer!: (yes: boolean) => void
const answered = new Promise<boolean>((resolve) => { answer = resolve })

export const appTab = {
  /** How many times ripple asked. */
  asked: 0,
  answer: (yes: boolean) => answer(yes),
}

export const isAppTab = (): Promise<boolean> => {
  appTab.asked++
  return answered
}
