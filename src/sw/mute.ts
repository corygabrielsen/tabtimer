// A blocked page's tab is muted, so media its content script can't reach
// (a cross-origin frame, a detached element) stops behind the block screen
// too. Only a mute this extension set is undone: one the user (or another
// extension) set stays. tabs.update needs no "tabs" permission.
type Tabs = {
  get: (tabId: number) => Promise<chrome.tabs.Tab>
  update: (tabId: number, props: { muted: boolean }) => Promise<unknown>
}

export function tabMuter(extensionId: string, tabs: Tabs = chrome.tabs): (tabId: number, on: boolean) => Promise<void> {
  return async (tabId, on) => {
    const { mutedInfo } = await tabs.get(tabId)
    const muted = mutedInfo?.muted === true
    const ours = muted && mutedInfo?.reason === 'extension' && mutedInfo.extensionId === extensionId
    if (on ? !muted : ours) {
      await tabs.update(tabId, { muted: on })
    }
  }
}
