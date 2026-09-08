const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export function decimalOrNull(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!DECIMAL.test(trimmed)) throw new Error(`invalid decimal: ${JSON.stringify(value)}`)
  return trimmed
}

export function addDecimals(values: string[]): string {
  let scale = 0
  const parsed = values.map(value => {
    const sign = value.startsWith('-') ? -1n : 1n
    const unsigned = value.replace(/^[+-]/, '')
    const [whole, fraction = ''] = unsigned.split('.')
    scale = Math.max(scale, fraction.length)
    return { sign, whole, fraction }
  })
  const total = parsed.reduce((sum, part) => {
    const digits = `${part.whole}${part.fraction.padEnd(scale, '0')}`
    return sum + part.sign * BigInt(digits || '0')
  }, 0n)
  const negative = total < 0n
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0')
  const rendered = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return `${negative ? '-' : ''}${rendered}`
}
