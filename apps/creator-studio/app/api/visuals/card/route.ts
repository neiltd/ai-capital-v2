import { createCanvas } from '@napi-rs/canvas'
import { NextRequest, NextResponse } from 'next/server'

const WIDTH = 1080
const HEIGHT = 1920

function wrapText(
  ctx: any,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): number {
  const words = text.split(' ')
  let line = ''
  let currentY = y

  for (const word of words) {
    const test = line + word + ' '
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      ctx.fillText(line.trim(), x, currentY)
      line = word + ' '
      currentY += lineHeight
    } else {
      line = test
    }
  }
  ctx.fillText(line.trim(), x, currentY)
  return currentY
}

export async function POST(req: NextRequest) {
  const { label = 'AI NEWS', prompt = '' } = await req.json()

  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#09090b'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const grad = ctx.createLinearGradient(0, HEIGHT * 0.6, 0, HEIGHT)
  grad.addColorStop(0, 'rgba(99,102,241,0)')
  grad.addColorStop(1, 'rgba(99,102,241,0.15)')
  ctx.fillStyle = grad
  ctx.fillRect(0, HEIGHT * 0.6, WIDTH, HEIGHT * 0.4)

  ctx.fillStyle = '#6366f1'
  ctx.fillRect(80, 240, 8, 100)

  ctx.fillStyle = '#6366f1'
  ctx.font = 'bold 38px sans-serif'
  ctx.fillText(label.toUpperCase(), 110, 305)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 76px sans-serif'
  wrapText(ctx, prompt, 80, 420, 920, 96)

  const handle = process.env.TIKTOK_USERNAME ?? 'yourchannel'
  ctx.fillStyle = '#52525b'
  ctx.font = '42px sans-serif'
  ctx.fillText(`@${handle}`, 80, 1820)

  const png = canvas.toBuffer('image/png')
  return new NextResponse(png as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="card-${Date.now()}.png"`,
    },
  })
}
