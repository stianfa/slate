import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Download, Maximize, Minus, Plus, RefreshCw, Search, X } from 'lucide-react'
import { targetKey, type Target } from '@shared/types'
import { anchor, buildDiagram, HEADER, ROW, type DiagramNode } from '../diagram/layout'
import { formatEstimate, shortType } from '../lib/format'
import { useStore } from '../store'
import { EnvBadge, EnvStrip, envStyle, useEnvironment } from './environment'
import { Popover, Spinner } from './ui'

// Fonts and colors are written as SVG attributes (not CSS) so an exported file looks the same.
const FONT_UI = "'Inter Variable', 'Segoe UI', sans-serif"
const FONT_MONO = "'JetBrains Mono Variable', Consolas, monospace"
const SCHEMA_COLORS = ['#7c9cff', '#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb923c', '#f87171']
const MIN_ZOOM = 0.08
const MAX_ZOOM = 2.5

interface Palette {
  bg: string
  surface: string
  header: string
  border: string
  edge: string
  text: string
  faint: string
  accent: string
  amber: string
  dots: string
}

function usePalette(): Palette {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    return {
      bg: v('--bg-editor'),
      surface: v('--bg-elevated'),
      header: v('--bg-chrome'),
      border: v('--border-strong'),
      edge: v('--text-faint'),
      text: v('--text'),
      faint: v('--text-faint'),
      accent: v('--accent'),
      amber: v('--amber'),
      dots: v('--border-strong')
    }
  }, [theme])
}

let measureContext: CanvasRenderingContext2D | null = null
const FONTS = { title: `600 13px ${FONT_UI}`, column: `12px ${FONT_MONO}`, type: `11px ${FONT_MONO}` }
function measure(text: string, font: keyof typeof FONTS): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * 7.5
  measureContext.font = FONTS[font]
  return measureContext.measureText(text).width
}

type Box = Pick<DiagramNode, 'x' | 'y' | 'width' | 'height'>
type NodeState = 'normal' | 'dim' | 'focus'

function bounds(boxes: Iterable<Box>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return minX === Infinity ? { minX: 0, minY: 0, width: 0, height: 0 } : { minX, minY, width: maxX - minX, height: maxY - minY }
}

/** Path from a foreign key column to the column it references, with crow's-foot ends. */
function edgeShape(from: Box, fromColumn: number, to: Box, toColumn: number, nullable: boolean, self: boolean) {
  let fromSide: 'left' | 'right' = 'right'
  let toSide: 'left' | 'right' = 'right'
  const overlap = from.x < to.x + to.width && to.x < from.x + from.width
  if (!self && !overlap) {
    const leftToRight = from.x + from.width / 2 < to.x + to.width / 2
    fromSide = leftToRight ? 'right' : 'left'
    toSide = leftToRight ? 'left' : 'right'
  }
  const a = anchor(from, fromColumn, fromSide)
  const b = anchor(to, toColumn, toSide)
  const da = fromSide === 'right' ? 1 : -1
  const db = toSide === 'right' ? 1 : -1
  const a2 = a.x + da * 22
  const b2 = b.x + db * 16
  const bend = Math.max(self ? 36 : 48, Math.abs(b2 - a2) / 2)
  const d = `M${a.x} ${a.y}H${a2}C${a2 + da * bend} ${a.y} ${b2 + db * bend} ${b.y} ${b2} ${b.y}H${b.x}`
  // Many side: crow's foot, plus a circle (optional) or bar (required).
  let marks = `M${a.x} ${a.y - 6}L${a.x + da * 11} ${a.y}L${a.x} ${a.y + 6}`
  if (!nullable) marks += `M${a.x + da * 16} ${a.y - 6}V${a.y + 6}`
  // One side: exactly one.
  marks += `M${b.x + db * 7} ${b.y - 6}V${b.y + 6}M${b.x + db * 12} ${b.y - 6}V${b.y + 6}`
  return { d, marks, circle: nullable ? { cx: a.x + da * 17, cy: a.y } : null }
}

const Edge = memo(function Edge({
  from,
  fromColumn,
  to,
  toColumn,
  nullable,
  self,
  color,
  width,
  opacity,
  background
}: {
  from: Box
  fromColumn: number
  to: Box
  toColumn: number
  nullable: boolean
  self: boolean
  color: string
  width: number
  opacity: number
  background: string
}) {
  const shape = edgeShape(from, fromColumn, to, toColumn, nullable, self)
  return (
    <g opacity={opacity}>
      <path d={shape.d} fill="none" stroke={color} strokeWidth={width} />
      <path d={shape.marks} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" />
      {shape.circle && <circle cx={shape.circle.cx} cy={shape.circle.cy} r={3.2} fill={background} stroke={color} strokeWidth={width} />}
    </g>
  )
})

const TableNode = memo(function TableNode({
  node,
  x,
  y,
  state,
  palette,
  schemaColor,
  keysOnly,
  onPointerDown,
  onHover,
  onOpen
}: {
  node: DiagramNode
  x: number
  y: number
  state: NodeState
  palette: Palette
  schemaColor: string
  keysOnly: boolean
  onPointerDown(e: ReactPointerEvent, id: string): void
  onHover(id: string | null): void
  onOpen(id: string): void
}) {
  const { table, columns, width, height } = node
  const title = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`
  const isView = table.kind.includes('view')
  const meta = isView
    ? table.kind
    : table.estimatedRows !== null && table.estimatedRows > 0
      ? `${formatEstimate(table.estimatedRows)} rows`
      : ''
  const focused = state === 'focus'
  return (
    <g
      transform={`translate(${x},${y})`}
      opacity={state === 'dim' ? 0.25 : 1}
      className="dg-table"
      data-table={node.id}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(node.id)}
    >
      <rect
        width={width}
        height={height}
        rx={10}
        fill={palette.surface}
        stroke={focused ? palette.accent : palette.border}
        strokeWidth={focused ? 1.6 : 1}
        filter="url(#dg-shadow)"
      />
      <path d={`M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v${HEADER - 10}h${-width}z`} fill={palette.header} />
      <line x1={0} x2={width} y1={HEADER} y2={HEADER} stroke={palette.border} />
      <circle cx={16} cy={HEADER / 2} r={4} fill={schemaColor} />
      <text
        x={28}
        y={HEADER / 2 + 4.5}
        fontFamily={FONT_UI}
        fontSize={13}
        fontWeight={600}
        fontStyle={isView ? 'italic' : undefined}
        fill={palette.text}
      >
        {title}
      </text>
      <text x={width - 12} y={HEADER / 2 + 4} textAnchor="end" fontFamily={FONT_UI} fontSize={11} fill={palette.faint}>
        {meta}
      </text>
      {columns.map((c, i) => {
        const top = HEADER + i * ROW
        const badge = c.pk ? 'PK' : c.fk ? 'FK' : null
        const badgeColor = c.pk ? palette.amber : palette.accent
        return (
          <g key={c.name}>
            {badge && (
              <>
                <rect x={9} y={top + 6} width={20} height={12} rx={3} fill={badgeColor} fillOpacity={0.16} />
                <text x={19} y={top + 15} textAnchor="middle" fontFamily={FONT_UI} fontSize={8} fontWeight={700} fill={badgeColor}>
                  {badge}
                </text>
              </>
            )}
            <text x={36} y={top + 16} fontFamily={FONT_MONO} fontSize={12} fill={palette.text}>
              {c.name}
            </text>
            <text x={width - 12} y={top + 16} textAnchor="end" fontFamily={FONT_MONO} fontSize={11} fill={palette.faint}>
              {shortType(c.type)}
              {c.nullable && !c.pk ? '?' : ''}
            </text>
          </g>
        )
      })}
      {columns.length === 0 && (
        <text x={14} y={HEADER + 16} fontFamily={FONT_UI} fontSize={11.5} fill={palette.faint}>
          {keysOnly ? 'No keys' : 'No columns'}
        </text>
      )}
    </g>
  )
})

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function DiagramView({ target }: { target: Target }) {
  const key = targetKey(target)
  const schemaState = useStore((s) => s.schemas[key])
  const loadSchema = useStore((s) => s.loadSchema)
  const openTable = useStore((s) => s.openTable)
  const connection = useStore((s) => s.connections.find((c) => c.id === target.connectionId))
  const palette = usePalette()
  const environment = useEnvironment(target)

  const [schemaFilter, setSchemaFilter] = useState<string | null>(null)
  const [keysOnly, setKeysOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [view, setView] = useState({ x: 40, y: 40, k: 1 })
  const svgRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<SVGGElement>(null)
  const drag = useRef<
    | { kind: 'pan'; startX: number; startY: number; origin: { x: number; y: number }; captured: boolean }
    | { kind: 'node'; id: string; startX: number; startY: number; origin: { x: number; y: number }; captured: boolean }
    | null
  >(null)

  useEffect(() => {
    void loadSchema(target)
  }, [key])

  const data = schemaState?.data
  const schemas = useMemo(() => [...new Set(data?.tables.map((t) => t.schema) ?? [])].sort(), [data])
  const schemaColors = useMemo(
    () => new Map(schemas.map((s, i) => [s, SCHEMA_COLORS[i % SCHEMA_COLORS.length]])),
    [schemas]
  )
  const diagram = useMemo(
    () => (data ? buildDiagram(data, { schemaFilter, keysOnly, measure, shortType }) : null),
    [data, schemaFilter, keysOnly]
  )
  const boxes = useMemo(
    () => new Map((diagram?.nodes ?? []).map((n) => [n.id, { ...n, ...moved[n.id] }])),
    [diagram, moved]
  )

  const fit = (nodes: Iterable<Box> = boxes.values()) => {
    const svg = svgRef.current
    if (!svg) return
    const { width: vw, height: vh } = svg.getBoundingClientRect()
    const b = bounds(nodes)
    if (!b.width) return
    const k = Math.min(Math.max(Math.min((vw - 80) / b.width, (vh - 80) / b.height), MIN_ZOOM), 1.1)
    setView({ k, x: (vw - b.width * k) / 2 - b.minX * k, y: (vh - b.height * k) / 2 - b.minY * k })
  }

  // A fresh layout (new schema, filter or column mode) starts unmoved and fitted to the screen.
  useLayoutEffect(() => {
    setMoved({})
    if (diagram) fit(diagram.nodes)
  }, [diagram])

  // Wheel zoom around the cursor. Registered natively so it can prevent the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
      setView((v) => {
        const k = Math.min(Math.max(v.k * factor, MIN_ZOOM), MAX_ZOOM)
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [diagram !== null])

  const zoomBy = (factor: number) => {
    const svg = svgRef.current
    if (!svg) return
    const { width, height } = svg.getBoundingClientRect()
    setView((v) => {
      const k = Math.min(Math.max(v.k * factor, MIN_ZOOM), MAX_ZOOM)
      return { k, x: width / 2 - ((width / 2 - v.x) * k) / v.k, y: height / 2 - ((height / 2 - v.y) * k) / v.k }
    })
  }

  const query = search.trim().toLowerCase()
  const matches = useMemo(
    () => (query && diagram ? new Set(diagram.nodes.filter((n) => n.table.name.toLowerCase().includes(query)).map((n) => n.id)) : null),
    [query, diagram]
  )
  const related = useMemo(() => {
    if (!hover || !diagram) return null
    const ids = new Set([hover])
    for (const e of diagram.edges) {
      if (e.from.node === hover || e.to.node === hover) {
        ids.add(e.from.node)
        ids.add(e.to.node)
      }
    }
    return ids
  }, [hover, diagram])

  const centerOn = (id: string) => {
    const box = boxes.get(id)
    const svg = svgRef.current
    if (!box || !svg) return
    const { width, height } = svg.getBoundingClientRect()
    const k = Math.max(view.k, 0.9)
    setView({ k, x: width / 2 - (box.x + box.width / 2) * k, y: height / 2 - (box.y + box.height / 2) * k })
  }

  const onBackgroundDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, origin: { x: view.x, y: view.y }, captured: false }
  }

  const onNodeDown = (e: ReactPointerEvent, id: string) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const box = boxes.get(id)
    if (!box) return
    drag.current = { kind: 'node', id, startX: e.clientX, startY: e.clientY, origin: { x: box.x, y: box.y }, captured: false }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    // Capture only once the pointer really moves, so clicks and double-clicks still reach the table.
    if (!d.captured) {
      if (Math.hypot(dx, dy) < 3) return
      svgRef.current?.setPointerCapture(e.pointerId)
      d.captured = true
    }
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }))
    else setMoved((m) => ({ ...m, [d.id]: { x: d.origin.x + dx / view.k, y: d.origin.y + dy / view.k } }))
  }

  const endDrag = (e: ReactPointerEvent) => {
    drag.current = null
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId)
  }

  const onHover = (id: string | null) => {
    if (!drag.current) setHover(id)
  }

  const onOpen = (id: string) => {
    const node = boxes.get(id)
    if (node) openTable(target, node.table)
  }

  const svgMarkup = () => {
    const content = contentRef.current
    const defs = svgRef.current?.querySelector('defs')
    if (!content) return null
    const b = bounds(boxes.values())
    const pad = 40
    const x = b.minX - pad
    const y = b.minY - pad
    const width = Math.ceil(b.width + pad * 2)
    const height = Math.ceil(b.height + pad * 2)
    const clone = content.cloneNode(true) as SVGGElement
    clone.removeAttribute('transform')
    return {
      width,
      height,
      text:
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">` +
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${palette.bg}"/>` +
        `${defs?.outerHTML ?? ''}${clone.outerHTML}</svg>`
    }
  }

  const fileName = `${target.database}-diagram`

  const exportSvg = () => {
    const svg = svgMarkup()
    if (svg) download(`${fileName}.svg`, new Blob([svg.text], { type: 'image/svg+xml' }))
  }

  const exportPng = () => {
    const svg = svgMarkup()
    if (!svg) return
    const scale = Math.min(2, 16000 / Math.max(svg.width, svg.height))
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(svg.width * scale)
      canvas.height = Math.round(svg.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(scale, scale)
      ctx.drawImage(image, 0, 0, svg.width, svg.height)
      canvas.toBlob((blob) => blob && download(`${fileName}.png`, blob), 'image/png')
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.text)}`
  }

  const nodeState = (id: string): NodeState => {
    if (related) return related.has(id) ? (id === hover ? 'focus' : 'normal') : 'dim'
    if (matches) return matches.has(id) ? 'focus' : 'dim'
    return 'normal'
  }

  let body
  if (!data) {
    body = (
      <div className="diagram-empty">
        {schemaState?.status === 'error' ? <span className="danger">{schemaState.error}</span> : <Spinner size={18} />}
      </div>
    )
  } else if (!diagram || diagram.nodes.length === 0) {
    body = <div className="diagram-empty muted">No tables in this database.</div>
  } else {
    body = (
      <svg
        ref={svgRef}
        className="diagram-canvas"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <filter id="dg-shadow" x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.18" />
          </filter>
          <pattern
            id="dg-dots"
            width={22}
            height={22}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}
          >
            <circle cx={1} cy={1} r={1} fill={palette.dots} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dg-dots)" />
        <g ref={contentRef} transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {diagram.edges.map((e) => {
            const from = boxes.get(e.from.node)!
            const to = boxes.get(e.to.node)!
            const touches = hover !== null && (e.from.node === hover || e.to.node === hover)
            const opacity = related ? (touches ? 1 : 0.1) : matches ? 0.25 : 0.85
            return (
              <Edge
                key={e.id}
                from={from}
                fromColumn={e.from.column}
                to={to}
                toColumn={e.to.column}
                nullable={e.from.nullable}
                self={e.from.node === e.to.node}
                color={touches ? palette.accent : palette.edge}
                width={touches ? 1.8 : 1.2}
                opacity={opacity}
                background={palette.surface}
              />
            )
          })}
          {diagram.nodes.map((n) => {
            const box = boxes.get(n.id)!
            return (
              <TableNode
                key={n.id}
                node={n}
                x={box.x}
                y={box.y}
                state={nodeState(n.id)}
                palette={palette}
                schemaColor={schemaColors.get(n.table.schema) ?? SCHEMA_COLORS[0]}
                keysOnly={keysOnly}
                onPointerDown={onNodeDown}
                onHover={onHover}
                onOpen={onOpen}
              />
            )
          })}
        </g>
      </svg>
    )
  }

  return (
    <div className={`diagram${environment ? ` env-${environment.id}` : ''}`} style={envStyle(environment)}>
      <EnvStrip env={environment} />
      <div className="toolbar">
        <div className="diagram-title">
          <span className="dot" style={{ background: connection?.color }} />
          <span className="target-name">{connection?.name}</span>
          <span className="target-sep">/</span>
          <span className="target-db">{target.database}</span>
          {environment && <EnvBadge env={environment} long />}
          {diagram && (
            <span className="muted small diagram-counts">
              {diagram.nodes.length} tables · {diagram.edges.length} relationships
            </span>
          )}
        </div>
        <div className="toolbar-sep" />
        {schemas.length > 1 && (
          <select
            className="toolbar-select"
            value={schemaFilter ?? ''}
            onChange={(e) => setSchemaFilter(e.target.value || null)}
            aria-label="Schema"
          >
            <option value="">All schemas</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <div className="segmented small">
          <button className={keysOnly ? '' : 'active'} onClick={() => setKeysOnly(false)}>
            All columns
          </button>
          <button className={keysOnly ? 'active' : ''} onClick={() => setKeysOnly(true)}>
            Keys only
          </button>
        </div>
        <div className="toolbar-search">
          <Search size={13} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches?.size) centerOn([...matches][0])
              if (e.key === 'Escape') setSearch('')
            }}
            placeholder="Find table"
            spellCheck={false}
          />
          {search && (
            <button className="icon-btn tiny" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
        <div className="grow" />
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.25)} title="Zoom out" disabled={!diagram}>
          <Minus size={15} />
        </button>
        <span className="zoom-level">{Math.round(view.k * 100)}%</span>
        <button className="icon-btn" onClick={() => zoomBy(1.25)} title="Zoom in" disabled={!diagram}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" onClick={() => fit()} title="Fit to screen" disabled={!diagram}>
          <Maximize size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={() => void loadSchema(target, true)}
          title="Reload schema and lay out again"
        >
          <RefreshCw size={14} />
        </button>
        <Popover
          align="right"
          trigger={(open, toggle) => (
            <button className={`ghost-btn${open ? ' active' : ''}`} onClick={toggle} disabled={!diagram}>
              <Download size={13} /> Export <ChevronDown size={12} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu">
              <button
                className="menu-item"
                onClick={() => {
                  exportPng()
                  close()
                }}
              >
                PNG image
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  exportSvg()
                  close()
                }}
              >
                SVG (vector)
              </button>
            </div>
          )}
        </Popover>
      </div>
      <div className="diagram-body">
        {body}
        {diagram && diagram.nodes.length > 0 && (
          <div className="diagram-hint">Drag tables to arrange · scroll to zoom · double-click a table to query it</div>
        )}
      </div>
    </div>
  )
}
