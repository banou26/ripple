// Ripple — screens & complex components

import { useState, useEffect } from 'react'

import { Icon, Logo } from './icons'
import { Cover, Sparkline, PeerFlag } from './cover'
import { fmtBytes, fmtSpeed, genSparkline } from './format'
import { watchHref, hasPlayableFile, pickVideoFile } from './watch'
import { getBackend, setBackend } from '../torrent/backend'
import type { Torrent, TorrentFile, TorrentPeer, Tweaks } from './types'

type ProtoMixProps = { utp: number, tcp: number }

export const ProtoMix = ({ utp, tcp }: ProtoMixProps) => (
  <span className="proto-mix" title={`${utp} µTP · ${tcp} TCP`}>
    <span className="proto-badge" data-proto="U">µ</span>
    <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{utp}</span>
    <span style={{ marginLeft: 4 }} className="proto-badge" data-proto="T">T</span>
    <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{tcp}</span>
  </span>
)

type SidebarView = 'active' | 'library' | 'settings'

type SidebarProps = {
  view: SidebarView
  setView: (view: SidebarView) => void
  counts: { active: number, library: number }
  totals: { down: number, up: number, utp: number, tcp: number }
}

export const Sidebar = ({ view, setView, counts, totals }: SidebarProps) => {
  const items: { id: SidebarView, label: string, icon: JSX.Element, count: number | null }[] = [
    { id: 'active', label: 'Active', icon: <Icon.Stream className="side-icon" />, count: counts.active },
    { id: 'library', label: 'Library', icon: <Icon.Library className="side-icon" />, count: counts.library },
    { id: 'settings', label: 'Settings', icon: <Icon.Settings className="side-icon" />, count: null },
  ]
  const total = totals.tcp + totals.utp || 1
  const utpPct = (totals.utp / total) * 100
  return (
    <aside className="side">
      <div className="side-brand">
        <div className="side-brand-mark"><Logo size={26} /></div>
        <div className="side-brand-name">Ripple<span>web</span></div>
      </div>

      <div className="side-section">Transfers</div>
      <nav className="side-nav">
        {items.map((it) => (
          <button key={it.id}
            className="side-item"
            data-active={view === it.id}
            onClick={() => setView(it.id)}>
            {it.icon}
            <span>{it.label}</span>
            {it.count != null && <span className="side-item-count">{it.count}</span>}
          </button>
        ))}
      </nav>

      <div className="side-footer">
        <div className="side-section" style={{ padding: '0 0 8px' }}>Network</div>
        <div className="side-net">
          <div className="side-net-cell">
            <div className="side-net-label">
              <Icon.ArrowDown style={{ width: 10, height: 10, color: 'var(--accent)' }} />
              Down
            </div>
            <div className="side-net-val">{fmtSpeed(totals.down).split(' ')[0]}<em>{fmtSpeed(totals.down).split(' ')[1] || ''}</em></div>
          </div>
          <div className="side-net-cell">
            <div className="side-net-label">
              <Icon.ArrowUp style={{ width: 10, height: 10, color: 'var(--good)' }} />
              Up
            </div>
            <div className="side-net-val">{fmtSpeed(totals.up).split(' ')[0]}<em>{fmtSpeed(totals.up).split(' ')[1] || ''}</em></div>
          </div>
        </div>
        <div className="side-protocols" title="Peer protocol mix">
          <div className="side-protocols-bar">
            <i style={{ width: utpPct + '%' }} />
          </div>
        </div>
        <div className="side-protocols-legend">
          <span>µTP {totals.utp}</span>
          <span>TCP {totals.tcp}</span>
        </div>
      </div>
    </aside>
  )
}

type TopBarProps = {
  title: string
  subtitle?: string | null
  search: string
  setSearch: (search: string) => void
  onAdd: () => void
}

export const TopBar = ({ title, subtitle, search, setSearch, onAdd }: TopBarProps) => (
  <div className="topbar">
    <div className="topbar-title">{title}{subtitle && <em>{subtitle}</em>}</div>
    <div className="search">
      <Icon.Search className="search-icon" />
      <input
        type="search"
        placeholder="Search transfers"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </div>
    <button className="btn btn-primary" onClick={onAdd}>
      <Icon.Plus className="icon" />
      Add transfer
    </button>
  </div>
)

type FilterId = 'all' | 'downloading' | 'seeding' | 'paused' | 'done'
type SortBy = 'added' | 'name' | 'progress' | 'speed' | 'size'

type FilterBarProps = {
  filter: string
  setFilter: (filter: string) => void
  sortBy: string
  setSortBy: (sortBy: string) => void
  counts: { all: number, downloading: number, seeding: number, paused: number, done: number }
  showAdv: boolean
  setShowAdv: (showAdv: boolean) => void
}

export const FilterBar = ({ filter, setFilter, sortBy, setSortBy, counts, showAdv, setShowAdv }: FilterBarProps) => {
  const filters: { id: FilterId, label: string, count: number | null }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'downloading', label: 'Downloading', count: counts.downloading },
    { id: 'seeding', label: 'Seeding', count: counts.seeding },
    { id: 'paused', label: 'Paused', count: counts.paused },
    { id: 'done', label: 'Complete', count: counts.done },
  ]
  return (
    <div className="filters">
      {filters.map((f) => (
        <button key={f.id} className="filter-pill"
          data-active={filter === f.id}
          onClick={() => setFilter(f.id)}>
          {f.label}
          {f.count != null && <span className="filter-pill-count">{f.count}</span>}
        </button>
      ))}
      <div className="filter-spacer" />
      <div className="filter-sort">
        Sort
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
          <option value="added">Recently added</option>
          <option value="name">Name</option>
          <option value="progress">Progress</option>
          <option value="speed">Speed</option>
          <option value="size">Size</option>
        </select>
      </div>
      <div className="filter-divider" />
      <button className="filter-pill" data-active={showAdv} onClick={() => setShowAdv(!showAdv)}
        title="Toggle technical stats">
        Stats
      </button>
    </div>
  )
}

type TorrentRowProps = {
  t: Torrent
  selected: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  showAdv: boolean
  onRemove?: (id: string) => void
  onSave?: (t: Torrent) => Promise<void>
}

export const TorrentRow = ({ t, selected, onSelect, onToggle, showAdv, onRemove, onSave }: TorrentRowProps) => {
  const [saving, setSaving] = useState(false)
  const doSave = async () => {
    if (!onSave || saving) return
    setSaving(true)
    try { await onSave(t) } catch {} finally { setSaving(false) }
  }
  const stateLabel = {
    downloading: 'Downloading', seeding: 'Seeding',
    paused: 'Paused', queued: 'Queued', done: 'Complete', error: 'Error',
  }[t.state]
  const isActive = t.state === 'downloading' || t.state === 'seeding'
  const coverSize = 44
  return (
    <div className="row"
      data-state={t.state}
      data-selected={selected}
      onClick={() => onSelect(t.id)}>
      <Cover name={t.name} size={coverSize} state={t.state} />

      <div className="row-body">
        <div className="row-top">
          <div className="row-name">{t.name}</div>
          <div className="row-meta">
            <span>{stateLabel}</span>
            <span className="row-meta-sep" />
            <span className="row-meta-mono">{fmtBytes(t.size)}</span>
            {t.peers.total > 0 && (
              <>
                <span className="row-meta-sep" />
                <ProtoMix utp={t.peers.utp} tcp={t.peers.tcp} />
              </>
            )}
            {t.eta && t.state === 'downloading' && (
              <>
                <span className="row-meta-sep" />
                <span className="row-meta-mono">{t.eta}</span>
              </>
            )}
          </div>
        </div>
        <div className="row-progress-wrap">
          <div className="progress">
            <div className="progress-fill"
              data-state={t.state}
              data-active={isActive}
              style={{ width: t.progress * 100 + '%' }} />
          </div>
          <div className="progress-pct">{Math.round(t.progress * 100)}%</div>
        </div>
        {showAdv && (
          <div className="row-adv">
            <span><b>Ratio</b> {t.ratio.toFixed(2)}</span>
            <span><b>Seeds</b> {t.seeds}</span>
            <span><b>Peers</b> {t.peers.total}</span>
            <span><b>Added</b> {t.added}</span>
          </div>
        )}
      </div>

      <div className="row-side" onClick={(e) => e.stopPropagation()}>
        <div className="speeds">
          <div className="speed speed-down">
            <Icon.ArrowDown className="speed-arrow" />{fmtSpeed(t.down)}
          </div>
          <div className={'speed speed-up' + (t.up > 0 ? ' active' : '')}>
            <Icon.ArrowUp className="speed-arrow" />{fmtSpeed(t.up)}
          </div>
        </div>
        <div className="row-actions">
          <button className="btn btn-ghost btn-icon" onClick={() => onToggle(t.id)} title={t.state === 'paused' ? 'Resume' : 'Pause'}>
            {t.state === 'paused' || t.state === 'queued' ? <Icon.Play /> : <Icon.Pause />}
          </button>
          {hasPlayableFile(t) && (
            <a className="btn btn-ghost btn-icon" href={watchHref(t)!} title="Watch">
              <Icon.Play />
            </a>
          )}
          {t.progress >= 1 && onSave && (
            <button className="btn btn-ghost btn-icon" onClick={doSave} disabled={saving}
              title={saving ? 'Saving…' : 'Save to disk'} style={{ fontSize: 10 }}>
              {saving ? '…' : <Icon.Download />}
            </button>
          )}
          {onRemove && (
            <button className="btn btn-ghost btn-icon" onClick={() => onRemove(t.id)} title="Remove from list">
              <Icon.Trash />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

type SectionHeaderProps = { label: string, count?: number | null }

export const SectionHeader = ({ label, count }: SectionHeaderProps) => (
  <div className="section-header">
    <h3>{label}</h3>
    {count != null && <span className="count">{count}</span>}
    <span className="line" />
  </div>
)

type HeroSparkProps = { id: string, down: number, up: number }

// Live speed graph for the hero card — rolling 60-sample buffer that ticks
// every second, driven by the torrent's current down speed (plus jitter).
export const HeroSpark = ({ id, down, up }: HeroSparkProps) => {
  const [series, setSeries] = useState<{ d: number[], u: number[] }>(() => {
    const seed = (parseInt(String(id).replace(/\D/g, ''), 10) || 1) * 13
    const base = genSparkline(seed, 60).map((v) => v * down)
    const ups = genSparkline(seed * 3, 60).map((v) => v * up)
    return { d: base, u: ups }
  })
  useEffect(() => {
    const i = setInterval(() => {
      setSeries((prev) => ({
        d: [...prev.d.slice(1), down * (0.78 + Math.random() * 0.44)],
        u: [...prev.u.slice(1), up * (0.78 + Math.random() * 0.44)],
      }))
    }, 900)
    return () => clearInterval(i)
  }, [down, up])
  const w = 420, h = 46
  const max = Math.max(...series.d, ...series.u, 1)
  const toPath = (arr: number[]) => {
    const step = w / (arr.length - 1)
    return arr.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(' ')
  }
  const toArea = (arr: number[]) => `${toPath(arr)} L ${w} ${h} L 0 ${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="hg-d" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".4" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hg-u" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--good)" stopOpacity=".3" />
          <stop offset="1" stopColor="var(--good)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={toArea(series.d)} fill="url(#hg-d)" />
      <path d={toPath(series.d)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={toArea(series.u)} fill="url(#hg-u)" />
      <path d={toPath(series.u)} fill="none" stroke="var(--good)" strokeWidth="1.3" strokeLinejoin="round" opacity="0.85" />
    </svg>
  )
}

type HeroCardProps = {
  t: Torrent
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  queuedCount: number
  onRemove?: (id: string) => void
  onSave?: (t: Torrent) => Promise<void>
}

export const HeroCard = ({ t, onSelect, onToggle, queuedCount, onRemove, onSave }: HeroCardProps) => {
  const [saving, setSaving] = useState(false)
  const doSave = async () => {
    if (!onSave || saving) return
    setSaving(true)
    try { await onSave(t) } catch {} finally { setSaving(false) }
  }
  const paused = t.state === 'paused' || t.state === 'queued'
  return (
  <article className="hero" onClick={() => onSelect(t.id)} style={{ cursor: 'pointer' }}>
    {/* Soft blurred halo of the cover behind the card */}
    <div className="hero-bg">
      <Cover name={t.name} size={400} />
    </div>
    <div className="hero-cover-wrap">
      <Cover name={t.name} size={156} />
    </div>
    <div className="hero-body">
      <div className="hero-eyebrow">
        <span className="dot" />
        Now downloading
        {queuedCount > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', letterSpacing: '0.04em', fontWeight: 500 }}>
            {queuedCount} in queue
          </span>
        )}
      </div>
      <h2 className="hero-name">{t.name}</h2>
      <div className="hero-meta">
        <span className="mono">{fmtBytes(t.downloaded || t.progress * t.size)} <span style={{ color: 'var(--text-faint)' }}>of {fmtBytes(t.size)}</span></span>
        <span className="hero-meta-dot" />
        <span>{t.eta} remaining</span>
        <span className="hero-meta-dot" />
        <ProtoMix utp={t.peers.utp} tcp={t.peers.tcp} />
      </div>
      <div className="hero-progress">
        <div className="progress">
          <div className="progress-fill"
            data-state={t.state}
            data-active={true}
            style={{ width: t.progress * 100 + '%' }} />
        </div>
        <div className="hero-pct">{(t.progress * 100).toFixed(1)}%</div>
      </div>
      <div className="hero-row">
        <div className="hero-stat">
          <div className="hero-stat-label">Down</div>
          <div className="hero-stat-val">
            {(t.down / 1024).toFixed(1)}<span className="unit">MB/s</span>
          </div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-label">Up</div>
          <div className="hero-stat-val">
            {t.up >= 1024 ? (t.up / 1024).toFixed(1) : t.up.toFixed(0)}
            <span className="unit">{t.up >= 1024 ? 'MB/s' : 'KB/s'}</span>
          </div>
        </div>
        <div className="hero-actions" onClick={(e) => e.stopPropagation()}>
          <button className="hero-action" onClick={() => onToggle(t.id)}>
            {paused ? <><Icon.Play className="icon" /> Resume</> : <><Icon.Pause className="icon" /> Pause</>}
          </button>
          <button className="hero-action" onClick={() => onSelect(t.id)}>
            Details
          </button>
          {t.progress >= 1 && onSave && (
            <button className="hero-action" onClick={doSave} disabled={saving}>
              <Icon.Download className="icon" /> {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {onRemove && (
            <button className="hero-action" onClick={() => onRemove(t.id)} title="Remove from list">
              <Icon.Trash className="icon" />
            </button>
          )}
          {hasPlayableFile(t) && (
            <a className="hero-action" data-primary="true" href={watchHref(t)!}>
              <Icon.Play className="icon" /> Watch
            </a>
          )}
        </div>
        <div className="hero-spark">
          <HeroSpark id={t.id} down={t.down} up={t.up} />
        </div>
      </div>
    </div>
  </article>
  )
}

type HeroEmptyProps = { onAdd: () => void }

export const HeroEmpty = ({ onAdd }: HeroEmptyProps) => (
  <div className="hero-empty">
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 12c3-4 6-4 9 0s6 4 9 0 6-4 9 0" opacity=".4" />
      <path d="M3 18c3-4 6-4 9 0s6 4 9 0 6-4 9 0" opacity=".7" />
      <path d="M3 24c3-4 6-4 9 0s6 4 9 0 6-4 9 0" />
    </svg>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>Nothing downloading right now</div>
      <div>All transfers are paused, seeding, or complete.</div>
    </div>
    <button className="btn btn-primary" onClick={onAdd}>
      <Icon.Plus className="icon" /> Add transfer
    </button>
  </div>
)

type EmptyStateProps = { onAdd: () => void, onPasteMagnet?: () => void }

export const EmptyState = ({ onAdd, onPasteMagnet }: EmptyStateProps) => (
  <div className="list-empty">
    <div>
      <div className="empty-illo">
        <svg viewBox="0 0 220 220">
          <circle cx="110" cy="110" r="20" className="r" />
          <circle cx="110" cy="110" r="20" className="r r2" />
          <circle cx="110" cy="110" r="20" className="r r3" />
          <circle cx="110" cy="110" r="20" fill="var(--accent)" opacity="0.16" />
          <circle cx="110" cy="110" r="6" fill="var(--accent)" />
        </svg>
      </div>
      <div className="empty-title">No transfers yet</div>
      <p className="empty-hint">Drop a .torrent file anywhere on this window, or paste a magnet link to get started.</p>
      <div className="empty-actions" style={{ justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={onAdd}>
          <Icon.Plus className="icon" /> Add transfer
        </button>
        <button className="btn" onClick={onPasteMagnet}>
          <Icon.Magnet className="icon" /> Paste magnet
        </button>
      </div>
      <div className="empty-shortcuts">
        <span><span className="kbd">⌘</span><span className="kbd">N</span> add</span>
        <span><span className="kbd">⌘</span><span className="kbd">V</span> paste magnet</span>
        <span><span className="kbd">/</span> search</span>
      </div>
    </div>
  </div>
)

type AddTorrentModalProps = {
  open: boolean
  onClose: () => void
  onAdd: (kind: 'file' | 'magnet', value?: string) => void
}

export const AddTorrentModal = ({ open, onClose, onAdd }: AddTorrentModalProps) => {
  const [magnet, setMagnet] = useState('')
  const [over, setOver] = useState(false)
  if (!open) return null
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Add a transfer</div>
          <button className="btn btn-ghost btn-icon modal-close" onClick={onClose}><Icon.Close /></button>
        </div>

        <label className={'dropzone' + (over ? ' over' : '')}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onAdd('file') }}>
          <div className="dropzone-ico">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 32c4-6 8-6 12 0s8 6 12 0 8-6 12 0" opacity=".35" />
              <path d="M8 24c4-6 8-6 12 0s8 6 12 0 8-6 12 0" opacity=".6" />
              <path d="M8 16c4-6 8-6 12 0s8 6 12 0 8-6 12 0" />
            </svg>
          </div>
          <div className="dropzone-title">Drop a .torrent file here</div>
          <div className="dropzone-hint">or <span className="browse">browse</span> from your computer</div>
          <input type="file" accept=".torrent" />
        </label>

        <div className="divider-or">or</div>

        <label className="field-label">Paste a magnet link</label>
        <input className="field" placeholder="magnet:?xt=urn:btih:…"
          value={magnet} onChange={(e) => setMagnet(e.target.value)} autoFocus />

        <div className="modal-foot">
          <div className="hint">
            Transfers run in your browser, tunnelling real peer connections over WebVPN. µTP &amp; TCP peers supported.
          </div>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onAdd('magnet', magnet)} disabled={!magnet && false}>
            Start transfer
          </button>
        </div>
      </div>
    </div>
  )
}

type DetailTab = 'overview' | 'files' | 'peers'

type DetailPanelProps = {
  t: Torrent | null | undefined
  onClose: () => void
  onSave?: (fileIndex: number, onProgress: (fraction: number) => void) => Promise<void>
  onToggle?: (id: string) => void
  onRemove?: (id: string, deleteFiles: boolean) => void
}

export const DetailPanel = ({ t, onClose, onSave, onToggle, onRemove }: DetailPanelProps) => {
  const [tab, setTab] = useState<DetailTab>('overview')
  // fileIndex -> save progress (0..1); -1 marks an error flash.
  const [saving, setSaving] = useState<Record<number, number>>({})
  const doSave = async (fileIndex: number) => {
    if (!onSave || saving[fileIndex] != null) return
    setSaving((s) => ({ ...s, [fileIndex]: 0 }))
    try {
      await onSave(fileIndex, (f) => setSaving((s) => ({ ...s, [fileIndex]: f })))
      setSaving((s) => { const n = { ...s }; delete n[fileIndex]; return n })
    } catch {
      setSaving((s) => ({ ...s, [fileIndex]: -1 }))
      setTimeout(() => setSaving((s) => { const n = { ...s }; delete n[fileIndex]; return n }), 2500)
    }
  }
  if (!t) return null
  const complete = t.state === 'done' || t.state === 'seeding' || t.progress >= 1
  const sparkD = genSparkline(parseInt(t.id.replace(/\D/g, ''), 10) || 1, 50)
  const sparkU = genSparkline((parseInt(t.id.replace(/\D/g, ''), 10) || 1) * 7, 50).map((x) => x * 0.4)
  return (
    <aside className="detail">
      <div className="detail-head">
        <h2 className="detail-name">
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: t.state === 'downloading' ? 'var(--accent)' :
                       t.state === 'seeding' ? 'var(--good)' : 'var(--text-faint)',
            marginRight: 4,
          }} />
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            display: 'inline-block', maxWidth: 300, verticalAlign: 'middle',
          }}>{t.name}</span>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><Icon.Close /></button>
        </h2>
        <div className="detail-sub">
          <span>{fmtBytes(t.size)}</span>
          <span>·</span>
          <span>added {t.added}</span>
        </div>
        <div className="detail-actions" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {hasPlayableFile(t) && (
            <a className="btn btn-primary" href={watchHref(t)!} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon.Play /> Watch
            </a>
          )}
          {onToggle && (
            <button className="btn btn-ghost" onClick={() => onToggle(t.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t.state === 'paused' || t.state === 'queued' ? <><Icon.Play /> Resume</> : <><Icon.Pause /> Stop</>}
            </button>
          )}
          {complete && onSave && t.files?.length ? (() => {
            const idx = pickVideoFile(t.files)
            const prog = saving[idx]
            return (
              <button className="btn btn-ghost" onClick={() => doSave(idx)} disabled={prog != null && prog >= 0}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon.Download /> {prog == null ? 'Save to disk' : prog < 0 ? 'Failed' : 'Saving ' + Math.round(prog * 100) + '%'}
              </button>
            )
          })() : null}
          {onRemove && (
            <button className="btn btn-ghost" onClick={() => onRemove(t.id, false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon.Trash /> Remove
            </button>
          )}
          {onRemove && (
            <button className="btn btn-ghost" onClick={() => onRemove(t.id, true)} title="Remove and delete the downloaded files from this device"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--bad, #e5484d)' }}>
              <Icon.Trash /> Delete data
            </button>
          )}
        </div>
      </div>

      <div className="detail-tabs">
        {([['overview', 'Overview'], ['files', 'Files'], ['peers', 'Peers']] as [DetailTab, string][]).map(([k, l]) => (
          <button key={k} className="detail-tab" data-active={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'overview' && (
          <>
            <div className="chart">
              <div className="chart-legend">
                <span><i style={{ background: 'var(--accent)' }} /> Down</span>
                <span><i style={{ background: 'var(--good)' }} /> Up</span>
              </div>
              <Sparkline down={sparkD} up={sparkU} />
            </div>

            <div className="stat-grid">
              <div>
                <div className="stat-label">Progress</div>
                <div className="stat-val">{Math.round(t.progress * 100)}<span className="unit">%</span></div>
              </div>
              <div>
                <div className="stat-label">ETA</div>
                <div className="stat-val">{t.eta}</div>
              </div>
              <div>
                <div className="stat-label">Down</div>
                <div className="stat-val">{fmtSpeed(t.down)}</div>
              </div>
              <div>
                <div className="stat-label">Up</div>
                <div className="stat-val">{fmtSpeed(t.up)}</div>
              </div>
              <div>
                <div className="stat-label">Peers</div>
                <div className="stat-val">{t.peers.total}<span className="unit">connected</span></div>
              </div>
              <div>
                <div className="stat-label">Seeds</div>
                <div className="stat-val">{t.seeds}</div>
              </div>
              <div>
                <div className="stat-label">Share ratio</div>
                <div className="stat-val">{t.ratio.toFixed(2)}</div>
              </div>
              <div>
                <div className="stat-label">Protocol mix</div>
                <div className="stat-val" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="proto-badge" data-proto="U">µTP</span>{t.peers.utp}
                  <span className="proto-badge" data-proto="T" style={{ marginLeft: 4 }}>TCP</span>{t.peers.tcp}
                </div>
              </div>
            </div>

            <div className="stat-label" style={{ marginBottom: 6 }}>Tracker</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
              {t.tracker}
            </div>
          </>
        )}

        {tab === 'files' && (
          <div className="file-tree">
            <div className="peers-head" style={{ gridTemplateColumns: '18px minmax(0,1fr) 60px 44px 32px' }}>
              <span></span><span>Name</span><span style={{ textAlign: 'right' }}>Size</span><span style={{ textAlign: 'right' }}>%</span><span></span>
            </div>
            {(t.files || [{ name: t.name, size: t.size, progress: t.progress }] as TorrentFile[]).map((f, i) => {
              const prog = saving[i]
              return (
                <div key={i} className={'file-row' + (f.progress >= 1 ? ' complete' : '')} style={{ gridTemplateColumns: '18px minmax(0,1fr) 60px 44px 32px' }}>
                  <Icon.File className="file-icon" />
                  <div className="file-name">{f.name}</div>
                  <div className="file-size">{fmtBytes(f.size)}</div>
                  <div className="file-pct">{Math.round(f.progress * 100)}%</div>
                  {complete && onSave ? (
                    <button className="btn btn-ghost btn-icon" title={prog == null ? 'Save to disk' : prog < 0 ? 'Save failed' : 'Saving…'}
                      onClick={() => doSave(i)} disabled={prog != null && prog >= 0}
                      style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                      {prog == null ? <Icon.Download /> : prog < 0 ? '!' : Math.round(prog * 100) + '%'}
                    </button>
                  ) : <span />}
                  <div className="mini-bar"><i style={{ width: f.progress * 100 + '%' }} /></div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'peers' && (
          <div>
            <div className="peers-head">
              <span></span><span>Address</span><span>Proto</span><span style={{ textAlign: 'right' }}>Down · Up</span><span style={{ textAlign: 'right' }}>%</span>
            </div>
            {(t.peerList || []).map((p: TorrentPeer, i: number) => (
              <div key={i} className="peer-row">
                <PeerFlag code={p.country} />
                <div className="peer-ip">{p.ip}</div>
                <div><span className="proto-badge" data-proto={p.proto}>{p.proto === 'U' ? 'µTP' : 'TCP'}</span></div>
                <div className="peer-speed">{p.down ? (p.down / 1024).toFixed(1) + ' ↓' : ''}{p.up ? ' ' + (p.up / 1024).toFixed(1) + ' ↑' : ''}</div>
                <div className="peer-pct">{Math.round(p.progress * 100)}%</div>
              </div>
            ))}
            {(!t.peerList || !t.peerList.length) && (
              <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>
                No peers connected.
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

type SettingsScreenProps = {
  tweak: Tweaks
  setTweak: (key: keyof Tweaks, value: any) => void
}

export const SettingsScreen = ({ tweak, setTweak }: SettingsScreenProps) => {
  const accents: { value: Tweaks['accent'], label: string }[] = [
    { value: 'water', label: 'Water' },
    { value: 'ember', label: 'Ember' },
    { value: 'moss', label: 'Moss' },
    { value: 'violet', label: 'Violet' },
  ]
  const backend = getBackend()
  return (
    <div className="settings">
      <div className="settings-section">
        <div className="settings-title">Engine</div>
        <p className="settings-desc">The BitTorrent engine Ripple downloads with. <strong>libtorrent-wasm</strong> is the native C++ engine; <strong>WebTorrent</strong> is the JS engine. Both tunnel real peers over WebVPN and store each torrent as a single file on disk. Switching restarts the app.</p>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Torrent engine</div>
            <div className="setting-hint">Each engine keeps its own storage, so a switch re-verifies (or re-downloads) your transfers.</div>
          </div>
          <div className="setting-control">
            <div className="filters" style={{ padding: 0, border: 'none' }}>
              {([['libtorrent', 'libtorrent'], ['webtorrent', 'WebTorrent']] as const).map(([v, l]) => (
                <button key={v} className="filter-pill" data-active={backend === v}
                  onClick={() => { if (backend !== v) setBackend(v) }}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-title">Appearance</div>
        <p className="settings-desc">Tune how Ripple looks and lays out your transfers. Changes apply instantly and persist on this device.</p>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Theme</div>
            <div className="setting-hint">Switch between a light and dark interface.</div>
          </div>
          <div className="setting-control">
            <div className="filters" style={{ padding: 0, border: 'none' }}>
              {(['light', 'dark'] as const).map((v) => (
                <button key={v} className="filter-pill" data-active={tweak.theme === v}
                  onClick={() => setTweak('theme', v)}>
                  {v === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Accent</div>
            <div className="setting-hint">The signature color used across progress bars and highlights.</div>
          </div>
          <div className="setting-control">
            <div className="filters" style={{ padding: 0, border: 'none' }}>
              {accents.map((a) => (
                <button key={a.value} className="filter-pill" data-active={tweak.accent === a.value}
                  onClick={() => setTweak('accent', a.value)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Layout</div>
            <div className="setting-hint">Hero spotlights your fastest download; List shows a flat feed.</div>
          </div>
          <div className="setting-control">
            <div className="filters" style={{ padding: 0, border: 'none' }}>
              {([['hero', 'Hero'], ['list', 'List']] as const).map(([v, l]) => (
                <button key={v} className="filter-pill" data-active={tweak.layout === v}
                  onClick={() => setTweak('layout', v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Density</div>
            <div className="setting-hint">How much breathing room rows get.</div>
          </div>
          <div className="setting-control">
            <div className="filters" style={{ padding: 0, border: 'none' }}>
              {([['compact', 'Compact'], ['regular', 'Regular'], ['comfy', 'Comfy']] as const).map(([v, l]) => (
                <button key={v} className="filter-pill" data-active={tweak.density === v}
                  onClick={() => setTweak('density', v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Show technical stats</div>
            <div className="setting-hint">Reveal ratio, seeds, peers and per-peer detail inline.</div>
          </div>
          <div className="setting-control">
            <button className="switch" data-on={tweak.showAdv} onClick={() => setTweak('showAdv', !tweak.showAdv)}><i /></button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-title">Connection</div>
        <p className="settings-desc">Ripple connects to peers over both µTP (UDP-based) and TCP, tunnelled out of the browser over WebVPN (WebTransport) — real BitTorrent peers, not WebRTC-only.</p>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Peer protocols</div>
            <div className="setting-hint">Disable a protocol to force-route traffic. Most users should leave both on.</div>
          </div>
          <div className="setting-control">
            <div className="proto-toggle">
              <button className="proto-toggle-cell" data-on={tweak.utp}
                onClick={() => setTweak('utp', !tweak.utp)}>
                <Icon.Check className="check" />
                <div>
                  <div className="name">µTP <span style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 11 }}>UDP</span></div>
                  <div className="sub">Low-latency, congestion-aware</div>
                </div>
              </button>
              <button className="proto-toggle-cell" data-on={tweak.tcp}
                onClick={() => setTweak('tcp', !tweak.tcp)}>
                <Icon.Check className="check" />
                <div>
                  <div className="name">TCP</div>
                  <div className="sub">Wider peer compatibility</div>
                </div>
              </button>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Max peers per transfer</div>
            <div className="setting-hint">More peers = faster, but heavier on your connection.</div>
          </div>
          <div className="setting-control" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>80</div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Encrypt traffic where possible</div>
            <div className="setting-hint">Negotiates encryption with peers that support it.</div>
          </div>
          <div className="setting-control">
            <button className="switch" data-on="true"><i /></button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-title">Bandwidth</div>
        <p className="settings-desc">Limit how much of your connection Ripple may use.</p>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Download limit</div>
            <div className="setting-hint">Unlimited.</div>
          </div>
          <div className="setting-control" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>—</div>
        </div>
        <div className="setting-row">
          <div className="setting-grow">
            <div className="setting-label">Upload limit</div>
            <div className="setting-hint">Capped at 2 MB/s.</div>
          </div>
          <div className="setting-control" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>2 MB/s</div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-title">About</div>
        <p className="settings-desc">Ripple — a browser-native BitTorrent client. v0.4.2 · build 2026-05-17</p>
      </div>
    </div>
  )
}

type HeroActiveViewProps = {
  list: Torrent[]
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  showAdv: boolean
  onAdd: () => void
}

export const HeroActiveView = ({ list, selectedId, onSelect, onToggle, showAdv, onAdd }: HeroActiveViewProps) => {
  // Pick the fastest active downloader as the hero
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
      showAdv={showAdv} />
  ))

  return (
    <div className="list">
      {hero ? (
        <HeroCard t={hero} onSelect={onSelect} onToggle={onToggle} queuedCount={queued.length} />
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
