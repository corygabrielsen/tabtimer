// A queue of async tasks: each starts once the one before it has settled.
// Pure: no chrome, no DOM.

export type Serial = <T>(task: () => Promise<T>) => Promise<T>

export function serial(): Serial {
  let chain: Promise<unknown> = Promise.resolve()
  return (task) => {
    const result = chain.then(task, task)
    // A failed task must not wedge the queue or fail the next one.
    chain = result.catch(() => undefined)
    return result
  }
}
