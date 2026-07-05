import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { prompt, label } = await req.json()

  const match = prompt.match(/\$?([\d.]+)\s*(B|M|T|billion|million|trillion)?/i)
  const value = match ? parseFloat(match[1]) : 0
  const unit = match?.[2]?.toUpperCase()[0] ?? ''

  const chartConfig = {
    type: 'bar',
    label,
    stat: `$${value}${unit}`,
    data: [
      { name: '2022', value: value * 0.2 },
      { name: '2023', value: value * 0.45 },
      { name: '2024', value: value * 0.72 },
      { name: '2025', value: value * 0.88 },
      { name: '2026', value },
    ],
  }

  return NextResponse.json(chartConfig)
}
