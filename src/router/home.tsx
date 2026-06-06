import type { Torrent, Tweaks } from '../ui/types'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'

const isMagnet = (s: string): boolean => /^magnet:\?/i.test(s.trim())
// v1 (btih) or v2 (btmh) info-hash from a magnet, for dedup detection.
const magnetInfoHash = (s: string): string | null => {
  const m = s.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

import {
  Sidebar,
  TopBar,
  FilterBar,
  TorrentRow,
  SectionHeader,
  HeroCard,
  HeroEmpty,
  EmptyState,
  AddTorrentModal,
  DetailPanel,
  SettingsScreen,
} from '../ui/screens'
import { useTorrents } from '../torrent/use-torrents'
import { saveTorrentFileToDisk } from '../torrent/save-file'
import { pickVideoFile } from '../ui/watch'
import { useTweaks, applyTweaks } from '../ui/use-tweaks'

const TWEAK_DEFAULTS: Tweaks = {
  theme: 'dark',
  accent: 'water',
  density: 'regular',
  layout: 'hero',
  showAdv: false,
  utp: true,
  tcp: true,
}

type HeroActiveViewProps = {
  list: Torrent[]
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  showAdv: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  onSave: (t: Torrent) => Promise<void>
}

const HeroActiveView = ({ list, selectedId, onSelect, onToggle, showAdv, onAdd, onRemove, onSave }: HeroActiveViewProps) => {
  const downloading = list.filter((t) => t.state === 'downloading').sort((a, b) => b.down - a.down)
  const hero = downloading[0] || null
  const heroId = hero?.id
  const queued = list.filter((t) => (t.state === 'downloading' && t.id !== heroId) || t.state === 'queued')
  const seeding = list.filter((t) => t.state === 'seeding')
  const paused = list.filter((t) => t.state === 'paused')
  const completed = list.filter((t) => t.state === 'done')

  const renderRows = (arr: Torrent[]) => arr.map((t) => (
    <TorrentRow key={t.id} t={t}
      selected={selectedId === t.id}
      onSelect={onSelect} onToggle={onToggle}
      onRemove={onRemove} onSave={onSave}
      showAdv={showAdv} />
  ))

  return (
    <div className="list">
      {hero ? (
        <HeroCard t={hero} onSelect={onSelect} onToggle={onToggle} onRemove={onRemove} onSave={onSave} queuedCount={queued.length} />
      ) : (
        <HeroEmpty onAdd={onAdd} />
      )}

      {queued.length > 0 && (
        <>
          <SectionHeader label="Up next" count={queued.length} />
          {renderRows(queued)}
        </>
      )}
      {seeding.length > 0 && (
        <>
          <SectionHeader label="Seeding" count={seeding.length} />
          {renderRows(seeding)}
        </>
      )}
      {paused.length > 0 && (
        <>
          <SectionHeader label="Paused" count={paused.length} />
          {renderRows(paused)}
        </>
      )}
      {completed.length > 0 && (
        <>
          <SectionHeader label="Complete" count={completed.length} />
          {renderRows(completed)}
        </>
      )}
    </div>
  )
}

const Home = () => {
  const [tweak, setTweak] = useTweaks(TWEAK_DEFAULTS)
  const [view, setView] = useState<'active' | 'library' | 'settings'>('active')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sortBy, setSortBy] = useState('added')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // Live torrents from the libtorrent-wasm worker (real peers over WebVPN).
  const { torrents, addMagnet, pause, resume, remove, clientRef } = useTorrents()

  // Read torrents from a ref inside stable callbacks so the global paste
  // listener doesn't re-subscribe on every 500ms state tick.
  const torrentsRef = useRef(torrents)
  torrentsRef.current = torrents
  const toastTimer = useRef<number | undefined>(undefined)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // Validate, add, and confirm a magnet. Returns false if it wasn't a magnet.
  const commitMagnet = useCallback((raw: string): boolean => {
    const text = raw.trim()
    if (!isMagnet(text)) return false
    const ih = magnetInfoHash(text)
    const dup = !!ih && torrentsRef.current.some((t) => t.magnet && magnetInfoHash(t.magnet) === ih)
    addMagnet(text)
    showToast(dup ? 'Already in your transfers' : 'Magnet added')
    return true
  }, [addMagnet, showToast])

  // Explicit "Paste magnet" button: pull the clipboard and add if it's a magnet.
  // Falls back to opening the modal when the clipboard read is blocked.
  const pasteMagnet = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (commitMagnet(text)) return
      showToast('No magnet link on your clipboard')
    } catch {
      setAddOpen(true)
    }
  }, [commitMagnet, showToast])

  // Global paste: Cmd/Ctrl+V anywhere outside a text field instantly adds a
  // magnet. The paste event carries the clipboard text with no permission
  // prompt (unlike navigator.clipboard.readText).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const text = e.clipboardData?.getData('text') ?? ''
      if (isMagnet(text)) { e.preventDefault(); setAddOpen(false); commitMagnet(text) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [commitMagnet])

  // Apply theme/accent/density to <html>
  useEffect(() => {
    applyTweaks(tweak)
  }, [tweak.theme, tweak.density, tweak.accent])

  // Keyboard: ⌘/Ctrl+N opens add, / focuses search, Esc closes detail/modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (addOpen && e.key === 'Escape') return setAddOpen(false)
      if (selectedId && e.key === 'Escape') return setSelectedId(null)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setAddOpen(true) }
      if (e.key === '/' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addOpen, selectedId])

  // Filtered/sorted list
  const filtered = useMemo(() => {
    let list = torrents.slice()
    if (view === 'library') {
      list = list.filter((t) => t.state === 'done' || t.state === 'seeding')
    } else if (view === 'active') {
      // active screen shows all states
    }
    if (filter !== 'all') {
      const map: Record<string, string[]> = { downloading: ['downloading'], seeding: ['seeding'], paused: ['paused', 'queued'], done: ['done'] }
      list = list.filter((t) => map[filter]?.includes(t.state))
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((t) => t.name.toLowerCase().includes(q))
    }
    const sorts: Record<string, (a: Torrent, b: Torrent) => number> = {
      added: (a, b) => 0,
      name: (a, b) => a.name.localeCompare(b.name),
      progress: (a, b) => b.progress - a.progress,
      speed: (a, b) => (b.down + b.up) - (a.down + a.up),
      size: (a, b) => b.size - a.size,
    }
    list.sort(sorts[sortBy] || sorts.added)
    return list
  }, [torrents, view, filter, search, sortBy])

  const counts = useMemo(() => {
    const c = { all: 0, downloading: 0, seeding: 0, paused: 0, done: 0 }
    torrents.forEach((t) => {
      c.all++
      if (t.state === 'downloading') c.downloading++
      else if (t.state === 'seeding') c.seeding++
      else if (t.state === 'paused' || t.state === 'queued') c.paused++
      else if (t.state === 'done') c.done++
    })
    return c
  }, [torrents])

  const sideCounts = {
    active: counts.downloading + counts.seeding + counts.paused,
    library: counts.done + counts.seeding,
  }

  const totals = useMemo(() => {
    const t = { down: 0, up: 0, utp: 0, tcp: 0 }
    torrents.forEach((x) => {
      t.down += x.down; t.up += x.up
      t.utp += x.peers.utp; t.tcp += x.peers.tcp
    })
    return t
  }, [torrents])

  const selected = torrents.find((t) => t.id === selectedId)

  // Export a finished file out of OPFS to the user's disk (streamed via the
  // worker's read()). Bound to the currently-selected torrent.
  const onSaveFile = async (fileIndex: number, onProgress: (f: number) => void) => {
    const client = clientRef.current
    const file = selected?.files?.[fileIndex]
    if (!client || !selected || !file) return
    const bytes = file.bytes ?? Math.round(file.size * 1024 * 1024)
    await saveTorrentFileToDisk(client, Number(selected.id), fileIndex, file.name, bytes, onProgress)
  }

  // Pause halts download + seeding (resumable). Toggle on the torrent's state.
  const onToggle = (id: string) => {
    const t = torrents.find((x) => x.id === id)
    if (!t) return
    if (t.state === 'paused' || t.state === 'queued') resume(Number(id))
    else pause(Number(id))
  }

  // Remove from the client (stops seeding). deleteFiles also wipes the OPFS data.
  const onRemove = (id: string, deleteFiles = false) => {
    remove(Number(id), deleteFiles)
    if (selectedId === id) setSelectedId(null)
  }

  // Save the torrent's primary file to disk straight from a list/hero row.
  const onSaveRow = async (t: Torrent) => {
    const client = clientRef.current
    if (!client || !t.files?.length) return
    const idx = pickVideoFile(t.files)
    const file = t.files[idx]
    if (!file) return
    const bytes = file.bytes ?? Math.round(file.size * 1024 * 1024)
    await saveTorrentFileToDisk(client, Number(t.id), idx, file.name, bytes)
  }

  const titleFor = (v: string) => v === 'active' ? 'Transfers' : v === 'library' ? 'Library' : 'Settings'
  const subtitleFor = (v: string) => v === 'active' ? `${counts.downloading} downloading · ${counts.seeding} seeding`
    : v === 'library' ? `${counts.done + counts.seeding} items`
    : null

  return (
    <div className="app">
      <Sidebar view={view} setView={setView}
        counts={sideCounts} totals={totals} />

      <div className="main">
        <TopBar title={titleFor(view)} subtitle={subtitleFor(view)}
          search={search} setSearch={setSearch}
          onAdd={() => setAddOpen(true)} />

        {view !== 'settings' && (
          <FilterBar
            filter={filter} setFilter={setFilter}
            sortBy={sortBy} setSortBy={setSortBy}
            counts={counts}
            showAdv={tweak.showAdv}
            setShowAdv={(v: boolean) => setTweak('showAdv', v)} />
        )}

        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            {view === 'settings' ? (
              <SettingsScreen tweak={tweak} setTweak={setTweak} />
            ) : filtered.length === 0 ? (
              <EmptyState onAdd={() => setAddOpen(true)} onPasteMagnet={pasteMagnet} />
            ) : tweak.layout === 'hero' && view === 'active' && filter === 'all' ? (
              <HeroActiveView
                list={filtered}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onToggle={onToggle}
                showAdv={tweak.showAdv}
                onAdd={() => setAddOpen(true)}
                onRemove={onRemove}
                onSave={onSaveRow} />
            ) : (
              <div className="list">
                {filtered.map((t) => (
                  <TorrentRow key={t.id} t={t}
                    selected={selectedId === t.id}
                    onSelect={setSelectedId}
                    onToggle={onToggle}
                    onRemove={onRemove}
                    onSave={onSaveRow}
                    showAdv={tweak.showAdv} />
                ))}
              </div>
            )}
          </div>
          {selected && view !== 'settings' && (
            <DetailPanel t={selected} onClose={() => setSelectedId(null)} onSave={onSaveFile} onToggle={onToggle} onRemove={onRemove} />
          )}
        </div>
      </div>

      <AddTorrentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(kind, value) => { if (kind === 'magnet' && value) commitMagnet(value); setAddOpen(false) }} />

      {toast && (
        <div role="status" className="toast" style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 8, zIndex: 200,
          background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 500,
          boxShadow: '0 10px 34px rgba(0,0,0,0.4)',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
          {toast}
        </div>
      )}
    </div>
  )
}

export default Home
