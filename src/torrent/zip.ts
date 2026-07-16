// Minimal streaming ZIP writer (STORE only) used to export a whole multifile
// torrent as one download. Everything streams through in a single pass: local
// headers carry zeroed CRC/sizes and the real values follow in a data
// descriptor (flag bit 3), so nothing is buffered or read twice. ZIP64 records
// kick in per entry for files >= 4 GiB and for headers past the 4 GiB offset.

export type ZipEntry = {
  path: string
  size: number
  read: (offset: number, len: number) => Promise<Uint8Array>
}

const CHUNK = 8 * 1024 * 1024
const U32_MAX = 0xFFFFFFFF

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c
})

const crc32 = (state: number, chunk: Uint8Array): number => {
  let c = state
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]!) & 0xFF]! ^ (c >>> 8)
  return c
}

// Little-endian struct builder for the fixed-layout ZIP records.
const struct = (size: number) => {
  const buf = new Uint8Array(size)
  const dv = new DataView(buf.buffer)
  let o = 0
  return {
    buf,
    u16: (v: number) => { dv.setUint16(o, v, true); o += 2 },
    u32: (v: number) => { dv.setUint32(o, v, true); o += 4 },
    u64: (v: number) => { dv.setBigUint64(o, BigInt(v), true); o += 8 },
    bytes: (b: Uint8Array) => { buf.set(b, o); o += b.length },
  }
}

export const writeZip = async (
  entries: ZipEntry[],
  write: (chunk: Uint8Array) => Promise<void>,
  onProgress?: (fraction: number) => void,
): Promise<void> => {
  const total = entries.reduce((n, e) => n + e.size, 0) || 1
  let done = 0
  let offset = 0
  const out = async (b: Uint8Array) => { await write(b); offset += b.length }

  const d = new Date()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()

  const central: Uint8Array[] = []

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path.split('/').filter(Boolean).join('/'))
    // A zip64 local header switches the data descriptor to 8-byte sizes, so the
    // decision is per entry and known upfront (STORE: compressed == size).
    const zip64 = entry.size >= U32_MAX
    const headerOffset = offset

    const lhExtra = zip64 ? 20 : 0
    const lh = struct(30 + name.length + lhExtra)
    lh.u32(0x04034B50)
    lh.u16(zip64 ? 45 : 20)          // version needed to extract
    lh.u16(0x0808)                   // bit 3: data descriptor, bit 11: UTF-8 names
    lh.u16(0)                        // method: store
    lh.u16(time)
    lh.u16(date)
    lh.u32(0)                        // crc: deferred to the descriptor
    lh.u32(zip64 ? U32_MAX : 0)      // sizes: deferred, 0xFFFFFFFF flags zip64
    lh.u32(zip64 ? U32_MAX : 0)
    lh.u16(name.length)
    lh.u16(lhExtra)
    lh.bytes(name)
    if (zip64) {
      lh.u16(0x0001)
      lh.u16(16)
      lh.u64(entry.size)             // uncompressed
      lh.u64(entry.size)             // compressed
    }
    await out(lh.buf)

    let crc = 0xFFFFFFFF
    for (let pos = 0; pos < entry.size; pos += CHUNK) {
      const len = Math.min(CHUNK, entry.size - pos)
      const chunk = await entry.read(pos, len)
      // The offsets recorded in the central directory assume exact lengths - a
      // short read would silently corrupt the archive, so fail loudly instead.
      if (chunk.length !== len) throw new Error(`short read: ${chunk.length}/${len} at ${pos} of ${entry.path}`)
      crc = crc32(crc, chunk)
      await out(chunk)
      done += len
      onProgress?.(done / total)
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0

    const dd = struct(zip64 ? 24 : 16)
    dd.u32(0x08074B50)
    dd.u32(crc)
    if (zip64) {
      dd.u64(entry.size)
      dd.u64(entry.size)
    } else {
      dd.u32(entry.size)
      dd.u32(entry.size)
    }
    await out(dd.buf)

    const offset64 = headerOffset >= U32_MAX
    const cdExtra = (zip64 ? 16 : 0) + (offset64 ? 8 : 0)
    const cd = struct(46 + name.length + (cdExtra ? 4 + cdExtra : 0))
    cd.u32(0x02014B50)
    cd.u16(45)                               // version made by
    cd.u16(zip64 || offset64 ? 45 : 20)      // version needed to extract
    cd.u16(0x0808)
    cd.u16(0)
    cd.u16(time)
    cd.u16(date)
    cd.u32(crc)
    cd.u32(zip64 ? U32_MAX : entry.size)
    cd.u32(zip64 ? U32_MAX : entry.size)
    cd.u16(name.length)
    cd.u16(cdExtra ? 4 + cdExtra : 0)
    cd.u16(0)                                // comment length
    cd.u16(0)                                // disk number start
    cd.u16(0)                                // internal attributes
    cd.u32(0)                                // external attributes
    cd.u32(offset64 ? U32_MAX : headerOffset)
    cd.bytes(name)
    if (cdExtra) {
      cd.u16(0x0001)
      cd.u16(cdExtra)
      if (zip64) {
        cd.u64(entry.size)
        cd.u64(entry.size)
      }
      if (offset64) cd.u64(headerOffset)
    }
    central.push(cd.buf)
  }

  const cdOffset = offset
  for (const c of central) await out(c)
  const cdSize = offset - cdOffset

  if (entries.length >= 0xFFFF || cdSize >= U32_MAX || cdOffset >= U32_MAX) {
    const eocd64Offset = offset
    const r = struct(56)
    r.u32(0x06064B50)
    r.u64(44)                        // size of the record past this field
    r.u16(45)
    r.u16(45)
    r.u32(0)                         // this disk
    r.u32(0)                         // disk with central directory
    r.u64(entries.length)
    r.u64(entries.length)
    r.u64(cdSize)
    r.u64(cdOffset)
    await out(r.buf)
    const loc = struct(20)
    loc.u32(0x07064B50)
    loc.u32(0)
    loc.u64(eocd64Offset)
    loc.u32(1)
    await out(loc.buf)
  }

  const eocd = struct(22)
  eocd.u32(0x06054B50)
  eocd.u16(0)
  eocd.u16(0)
  eocd.u16(Math.min(entries.length, 0xFFFF))
  eocd.u16(Math.min(entries.length, 0xFFFF))
  eocd.u32(Math.min(cdSize, U32_MAX))
  eocd.u32(Math.min(cdOffset, U32_MAX))
  eocd.u16(0)
  await out(eocd.buf)
}
