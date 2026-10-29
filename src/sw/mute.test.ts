import { describe, it, expect, vi } from 'vitest'
import { tabMuter } from './mute'

const ID = 'tabtimer-test'

function tabs(mutedInfo: chrome.tabs.MutedInfo) {
  return {
    get: vi.fn((tabId: number) => Promise.resolve({ id: tabId, mutedInfo } as chrome.tabs.Tab)),
    update: vi.fn(() => Promise.resolve(undefined)),
  }
}

describe('tabMuter', () => {
  it('mutes an unmuted tab, and leaves one already muted', async () => {
    const unmuted = tabs({ muted: false })
    await tabMuter(ID, unmuted)(1, true)
    expect(unmuted.update).toHaveBeenCalledWith(1, { muted: true })
    const muted = tabs({ muted: true, reason: 'user' })
    await tabMuter(ID, muted)(1, true)
    expect(muted.update).not.toHaveBeenCalled()
  })

  it('unmutes only its own mute', async () => {
    const ours = tabs({ muted: true, reason: 'extension', extensionId: ID })
    await tabMuter(ID, ours)(1, false)
    expect(ours.update).toHaveBeenCalledWith(1, { muted: false })
    for (const info of [
      { muted: true, reason: 'user' },
      { muted: true, reason: 'extension', extensionId: 'other' },
      { muted: false },
    ] as chrome.tabs.MutedInfo[]) {
      const theirs = tabs(info)
      await tabMuter(ID, theirs)(1, false)
      expect(theirs.update).not.toHaveBeenCalled()
    }
  })
})
