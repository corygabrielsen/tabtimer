// Messages from content scripts / popup to the background single-writer.

export type AddElapsedMessage = { type: 'addElapsed'; key: string; delta: number }
export type ResetKeyMessage = { type: 'resetKey'; key: string }
export type Message = AddElapsedMessage | ResetKeyMessage

export type MessageResponse = { ok: true; total: number } | { ok: false; error: string }

export function sendMessage(message: Message): Promise<MessageResponse> {
  return new Promise<MessageResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(error)
      } else {
        resolve(response)
      }
    })
  })
}
