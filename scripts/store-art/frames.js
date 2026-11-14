// A still for each of Blender's open films, drawn here so the library's posters and the player have
// something to show: scenes in the spirit of each film, not frames taken from it. Each draws on a 1280x720
// canvas with a seeded random, so a redraw gives the same picture.

export const FILMS = ['sintel', 'big-buck-bunny', 'tears-of-steel', 'elephants-dream', 'cosmos-laundromat']

const W = 1280
const H = 720

const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const linear = (g, y0, y1, stops) => {
  const gradient = g.createLinearGradient(0, y0, 0, y1)
  for (const [at, colour] of stops) gradient.addColorStop(at, colour)
  return gradient
}

const glow = (g, x, y, r, colour, alpha) => {
  const gradient = g.createRadialGradient(x, y, 0, x, y, r)
  gradient.addColorStop(0, `rgba(${colour}, ${alpha})`)
  gradient.addColorStop(1, `rgba(${colour}, 0)`)
  g.fillStyle = gradient
  g.fillRect(x - r, y - r, r * 2, r * 2)
}

/** A mountain line across the frame by midpoint displacement, as points. */
const ridge = (random, base, amplitude, roughness = 0.55) => {
  let points = [base + (random() - 0.5) * amplitude, base + (random() - 0.5) * amplitude]
  let spread = amplitude
  for (let level = 0; level < 7; level++) {
    const next = []
    for (let i = 0; i < points.length - 1; i++) next.push(points[i], (points[i] + points[i + 1]) / 2 + (random() - 0.5) * spread)
    next.push(points.at(-1))
    points = next
    spread *= roughness
  }
  return points.map((y, i) => [(i / (points.length - 1)) * W, y])
}

const fillBelow = (g, points, fill) => {
  g.beginPath()
  g.moveTo(0, H)
  for (const [x, y] of points) g.lineTo(x, y)
  g.lineTo(W, H)
  g.closePath()
  g.fillStyle = fill
  g.fill()
}

const circles = (g, list, fill) => {
  g.fillStyle = fill
  for (const [x, y, r] of list) {
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
}

const sintel = (g, random) => {
  g.fillStyle = linear(g, 0, H, [[0, '#121831'], [0.38, '#38345f'], [0.68, '#a15f78'], [0.86, '#ee9f70'], [1, '#ffd295']])
  g.fillRect(0, 0, W, H)
  for (let i = 0; i < 110; i++) {
    g.fillStyle = `rgba(255, 245, 230, ${0.15 + random() * 0.6})`
    g.fillRect(random() * W, random() * H * 0.36, 1.6, 1.6)
  }
  glow(g, 860, 500, 420, '255, 205, 150', 0.55)
  circles(g, [[860, 492, 34]], '#ffe7c2')
  // a dragon in the distance, wings spread
  g.fillStyle = '#2a2441'
  g.beginPath()
  g.moveTo(330, 196); g.quadraticCurveTo(300, 150, 250, 160); g.quadraticCurveTo(292, 172, 312, 204)
  g.quadraticCurveTo(330, 212, 352, 204); g.quadraticCurveTo(372, 170, 418, 150); g.quadraticCurveTo(372, 150, 344, 194)
  g.closePath(); g.fill()
  g.beginPath(); g.moveTo(312, 204); g.quadraticCurveTo(286, 222, 262, 214); g.quadraticCurveTo(290, 214, 318, 200); g.fill()
  const layers = [
    { base: 430, amplitude: 230, fill: '#7a6a93', rim: 'rgba(255, 225, 205, 0.3)' },
    { base: 505, amplitude: 190, fill: '#4b4570', rim: 'rgba(255, 210, 190, 0.18)' },
    { base: 580, amplitude: 150, fill: '#28284a', rim: 'rgba(255, 200, 180, 0.1)' },
  ]
  for (const { base, amplitude, fill, rim } of layers) {
    const line = ridge(random, base, amplitude)
    fillBelow(g, line, fill)
    g.strokeStyle = rim
    g.lineWidth = 2
    g.beginPath()
    line.forEach(([x, y], i) => (i ? g.lineTo(x, y + 1) : g.moveTo(x, y + 1)))
    g.stroke()
    g.fillStyle = linear(g, base - 60, H, [[0, 'rgba(240, 170, 140, 0)'], [1, 'rgba(240, 170, 140, 0.12)']])
    g.fillRect(0, base - 60, W, H)
  }
  const near = ridge(random, 650, 60, 0.5).map(([x, y]) => [x, y - Math.max(0, 70 - Math.abs(x - 430) * 0.25)])
  fillBelow(g, near, '#121325')
  // a lone traveller in a hooded cloak, a staff in hand, on the near ridge
  const top = near.reduce((best, point) => Math.abs(point[0] - 430) < Math.abs(best[0] - 430) ? point : best)[1]
  g.fillStyle = '#0b0c18'
  g.beginPath()
  g.moveTo(414, top + 4)
  g.quadraticCurveTo(420, top - 30, 424, top - 46)
  g.quadraticCurveTo(428, top - 62, 433, top - 64)
  g.quadraticCurveTo(440, top - 58, 439, top - 44)
  g.quadraticCurveTo(444, top - 24, 452, top + 4)
  g.closePath()
  g.fill()
  g.beginPath()
  g.moveTo(436, top - 40); g.quadraticCurveTo(452, top - 18, 470, top + 4); g.lineTo(448, top + 4); g.closePath()
  g.fill()
  g.strokeStyle = '#0b0c18'; g.lineWidth = 3; g.lineCap = 'round'
  g.beginPath(); g.moveTo(446, top + 4); g.lineTo(452, top - 74); g.stroke()
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(255, 255, 255, ${0.25 + random() * 0.55})`
    g.beginPath()
    g.arc(random() * W, random() * H, 0.8 + random() * 2.2, 0, Math.PI * 2)
    g.fill()
  }
}

const bigBuckBunny = (g, random) => {
  g.fillStyle = linear(g, 0, H, [[0, '#4ea4ef'], [0.55, '#a9d9fb'], [1, '#e6f6ff']])
  g.fillRect(0, 0, W, H)
  glow(g, 1080, 110, 360, '255, 248, 210', 0.85)
  circles(g, [[1080, 110, 58]], '#fffbe6')
  for (const [cx, cy, s] of [[220, 130, 1], [610, 90, 0.8], [880, 230, 0.65]]) {
    circles(g, [[cx - 70 * s, cy + 10 * s, 42 * s], [cx, cy - 12 * s, 60 * s], [cx + 72 * s, cy + 6 * s, 46 * s], [cx + 10 * s, cy + 22 * s, 48 * s]], 'rgba(255, 255, 255, 0.95)')
  }
  const hill = (base, amplitude, phase, fill) => fillBelow(g, Array.from({ length: 65 }, (_, i) => {
    const x = (i / 64) * W
    return [x, base + Math.sin(x / 260 + phase) * amplitude + Math.sin(x / 97 + phase * 2) * amplitude * 0.25]
  }), fill)
  hill(470, 30, 0.4, '#9bd26f')
  hill(530, 26, 2.1, '#72bd4c')
  hill(610, 20, 4.2, '#4f9c36')
  // the big tree, right of centre
  g.fillStyle = '#6a4527'
  g.beginPath()
  g.moveTo(905, 640); g.quadraticCurveTo(930, 520, 918, 380); g.lineTo(960, 380); g.quadraticCurveTo(956, 520, 990, 640)
  g.closePath(); g.fill()
  g.strokeStyle = '#6a4527'; g.lineWidth = 18; g.lineCap = 'round'
  g.beginPath(); g.moveTo(930, 430); g.quadraticCurveTo(880, 380, 840, 330); g.moveTo(950, 410); g.quadraticCurveTo(1010, 360, 1050, 320); g.stroke()
  const canopy = []
  for (let i = 0; i < 26; i++) canopy.push([940 + (random() - 0.5) * 330, 300 + (random() - 0.5) * 170, 50 + random() * 40])
  circles(g, canopy, '#3e8a37')
  circles(g, canopy.map(([x, y, r]) => [x - r * 0.2, y - r * 0.25, r * 0.7]), '#55a443')
  circles(g, canopy.filter(() => random() > 0.5).map(([x, y, r]) => [x - r * 0.35, y - r * 0.4, r * 0.35]), '#7dc65a')
  // the burrow under the tree
  g.fillStyle = '#2d1d10'
  g.beginPath(); g.ellipse(1020, 650, 46, 18, 0, 0, Math.PI * 2); g.fill()
  for (let i = 0; i < 160; i++) {
    const x = random() * W
    const y = 600 + random() * 120
    circles(g, [[x, y, 2 + random() * 3]], ['#ffd6e8', '#fff3a6', '#ffffff', '#ffb3c7'][Math.floor(random() * 4)])
  }
  for (const [x, y, colour] of [[300, 420, '#ff8fb8'], [360, 380, '#ffd34d']]) {
    g.fillStyle = colour
    g.beginPath(); g.ellipse(x - 9, y, 11, 7, -0.5, 0, Math.PI * 2); g.ellipse(x + 9, y, 11, 7, 0.5, 0, Math.PI * 2); g.fill()
  }
}

const tearsOfSteel = (g, random) => {
  g.fillStyle = linear(g, 0, H, [[0, '#06161d'], [0.45, '#15444d'], [0.72, '#3f7a74'], [0.86, '#d98a4c'], [1, '#f3b26b']])
  g.fillRect(0, 0, W, H)
  glow(g, 640, 620, 520, '255, 170, 100', 0.5)
  for (const x of [180, 520, 980, 1150]) {
    g.fillStyle = linear(g, 0, 600, [[0, 'rgba(140, 240, 240, 0)'], [1, 'rgba(140, 240, 240, 0.16)']])
    g.fillRect(x, 0, 14, 600)
  }
  const skyline = (count, minH, maxH, base, fill, lit) => {
    let x = -20
    for (let i = 0; i < count && x < W; i++) {
      const w = 40 + random() * 90
      const h = minH + random() * (maxH - minH)
      g.fillStyle = fill
      g.fillRect(x, base - h, w, h + 200)
      if (random() > 0.6) g.fillRect(x + w / 2 - 2, base - h - 40, 4, 40)
      for (let wy = base - h + 12; wy < base - 8; wy += 14) {
        for (let wx = x + 6; wx < x + w - 8; wx += 12) {
          if (random() < lit) {
            g.fillStyle = random() > 0.3 ? 'rgba(255, 190, 110, 0.85)' : 'rgba(150, 240, 235, 0.8)'
            g.fillRect(wx, wy, 5, 6)
          }
        }
      }
      x += w + 6 + random() * 18
    }
  }
  skyline(40, 120, 330, 560, '#15363f', 0.12)
  g.fillStyle = linear(g, 380, 600, [[0, 'rgba(60, 140, 140, 0)'], [1, 'rgba(60, 140, 140, 0.35)']])
  g.fillRect(0, 380, W, 220)
  // a bridge on cables across the frame
  g.strokeStyle = '#0a1e24'
  g.lineWidth = 2
  for (const [tower, side] of [[330, -1], [330, 1], [960, -1], [960, 1]]) {
    for (let i = 1; i <= 9; i++) {
      g.beginPath(); g.moveTo(tower, 360); g.lineTo(tower + side * i * 34, 520); g.stroke()
    }
  }
  g.fillStyle = '#0a1e24'
  g.fillRect(322, 350, 16, 260); g.fillRect(952, 350, 16, 260)
  g.fillRect(0, 516, W, 14)
  skyline(26, 160, 420, 720, '#071318', 0.08)
}

const gear = (g, x, y, r, teeth, fill, rotation = 0) => {
  g.save()
  g.translate(x, y)
  g.rotate(rotation)
  g.beginPath()
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2
    const radius = i % 2 ? r : r * 1.14
    g.arc(0, 0, radius, a0, a1)
  }
  g.closePath()
  g.fillStyle = fill
  g.fill()
  g.globalCompositeOperation = 'destination-out'
  g.beginPath(); g.arc(0, 0, r * 0.32, 0, Math.PI * 2); g.fill()
  g.globalCompositeOperation = 'source-over'
  g.restore()
}

const elephantsDream = (g, random) => {
  g.fillStyle = linear(g, 0, H, [[0, '#120b08'], [0.5, '#2e1b10'], [1, '#160d08']])
  g.fillRect(0, 0, W, H)
  glow(g, 560, 360, 460, '255, 150, 60', 0.55)
  const brass = (x, y, r) => {
    const gradient = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r * 1.2)
    gradient.addColorStop(0, '#e6aa5a')
    gradient.addColorStop(1, '#5c3517')
    return gradient
  }
  gear(g, 250, 210, 170, 18, '#2a180d', 0.1)
  gear(g, 1030, 520, 230, 22, '#24150b', 0.3)
  gear(g, 560, 360, 120, 14, brass(560, 360, 120), 0.2)
  gear(g, 735, 250, 78, 10, brass(735, 250, 78), 0.5)
  gear(g, 430, 520, 64, 9, brass(430, 520, 64), 0.1)
  glow(g, 560, 360, 60, '255, 210, 140', 0.9)
  g.lineCap = 'round'
  for (const [width, colour] of [[34, '#3d2413'], [22, '#8a5428'], [6, 'rgba(255, 200, 130, 0.5)']]) {
    g.strokeStyle = colour
    g.lineWidth = width
    g.beginPath(); g.moveTo(-20, 620); g.bezierCurveTo(260, 560, 360, 700, 640, 640); g.bezierCurveTo(880, 590, 980, 720, 1300, 660); g.stroke()
    g.beginPath(); g.moveTo(900, -20); g.bezierCurveTo(860, 160, 980, 260, 900, 420); g.stroke()
  }
  g.strokeStyle = 'rgba(10, 6, 4, 0.9)'
  g.lineWidth = 3
  for (let i = 0; i < 9; i++) {
    g.beginPath()
    g.moveTo(random() * W, -10)
    g.bezierCurveTo(random() * W, 200 + random() * 200, random() * W, 300 + random() * 200, random() * W, H + 10)
    g.stroke()
  }
  // a walkway and its rail
  g.fillStyle = '#0d0805'
  g.fillRect(0, 668, W, 60)
  g.fillRect(0, 610, W, 5)
  for (let x = 20; x < W; x += 70) g.fillRect(x, 610, 5, 60)
  for (let i = 0; i < 70; i++) circles(g, [[random() * W, random() * H, 1 + random() * 2]], `rgba(255, 190, 110, ${0.2 + random() * 0.5})`)
}

const cosmosLaundromat = (g, random) => {
  g.fillStyle = linear(g, 0, 470, [[0, '#24173f'], [0.45, '#7b3a78'], [0.8, '#e9745f'], [1, '#ffc37b']])
  g.fillRect(0, 0, W, 470)
  for (const [x, y, w] of [[160, 150, 420], [700, 110, 520], [420, 280, 380], [980, 250, 340]]) {
    g.fillStyle = 'rgba(255, 170, 190, 0.35)'
    g.beginPath(); g.ellipse(x, y, w / 2, 14, 0, 0, Math.PI * 2); g.fill()
  }
  glow(g, 820, 470, 380, '255, 200, 130', 0.7)
  g.save()
  g.beginPath(); g.rect(0, 0, W, 470); g.clip()
  circles(g, [[820, 470, 92]], '#ffd894')
  g.restore()
  g.fillStyle = linear(g, 470, H, [[0, '#4a2e63'], [1, '#140f2a']])
  g.fillRect(0, 470, W, H - 470)
  for (let i = 0; i < 46; i++) {
    const y = 478 + i * 5.4 + random() * 3
    const w = (260 - i * 4) * (0.6 + random() * 0.6)
    g.fillStyle = `rgba(255, 210, 150, ${0.5 - i * 0.009})`
    g.fillRect(820 - w / 2 + (random() - 0.5) * 30, y, w, 2)
  }
  // the island, its bare tree and the sheep on it
  g.fillStyle = '#1b1530'
  g.beginPath(); g.ellipse(360, 486, 230, 46, 0, Math.PI, 0); g.fill()
  g.strokeStyle = '#1b1530'
  g.lineCap = 'round'
  const branch = (x, y, angle, length, width) => {
    if (width < 1.5) return
    const x2 = x + Math.cos(angle) * length
    const y2 = y + Math.sin(angle) * length
    g.lineWidth = width
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke()
    branch(x2, y2, angle - 0.42 + (random() - 0.5) * 0.3, length * 0.74, width * 0.66)
    branch(x2, y2, angle + 0.38 + (random() - 0.5) * 0.3, length * 0.72, width * 0.66)
  }
  branch(300, 470, -Math.PI / 2 - 0.08, 80, 14)
  circles(g, [[430, 452, 22], [452, 446, 20], [470, 454, 19], [448, 462, 20], [424, 464, 16]], '#f6eee6')
  circles(g, [[488, 448, 10]], '#2b2238')
  g.fillStyle = '#2b2238'
  g.fillRect(432, 470, 4, 12); g.fillRect(460, 470, 4, 12)
}

const DRAW = { sintel, 'big-buck-bunny': bigBuckBunny, 'tears-of-steel': tearsOfSteel, 'elephants-dream': elephantsDream, 'cosmos-laundromat': cosmosLaundromat }

/** Draws `film` filling a `width` by `height` context, cropped to cover it as a poster is. */
export const drawFrame = (g, film, width = W, height = H) => {
  const scale = Math.max(width / W, height / H)
  g.save()
  g.translate((width - W * scale) / 2, (height - H * scale) / 2)
  g.scale(scale, scale)
  DRAW[film](g, seeded(FILMS.indexOf(film) + 7))
  g.restore()
}
