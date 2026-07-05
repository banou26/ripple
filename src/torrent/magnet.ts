export const magnetInfoHash = (magnet: string): string | null => {
  const m = magnet.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}
