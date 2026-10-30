function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

// Format a millisecond duration as HH:MM:SS, clamping negatives to zero
// (a backward clock jump can drive elapsed below zero).
export function formatTime(millis: number): string {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
}
