import dagre from '@dagrejs/dagre'
import type { ColumnInfo, SchemaInfo, TableInfo } from '@shared/types'

export const HEADER = 36
export const ROW = 24
export const FOOTER = 6

export interface DiagramNode {
  id: string
  table: TableInfo
  columns: ColumnInfo[]
  /** Top-left corner. */
  x: number
  y: number
  width: number
  height: number
}

export interface DiagramEdge {
  id: string
  from: { node: string; column: number; nullable: boolean }
  to: { node: string; column: number }
}

export interface Diagram {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export const tableId = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`

type Measure = (text: string, font: 'title' | 'column' | 'type') => number

export function buildDiagram(
  schema: SchemaInfo,
  options: { schemaFilter: string | null; keysOnly: boolean; measure: Measure; shortType(t: string): string }
): Diagram {
  const tables = schema.tables.filter((t) => !options.schemaFilter || t.schema === options.schemaFilter)
  const ids = new Set(tables.map(tableId))

  const nodes: DiagramNode[] = tables.map((table) => {
    const columns = options.keysOnly ? table.columns.filter((c) => c.pk || c.fk) : table.columns
    const title = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`
    let width = options.measure(title, 'title') + 70
    for (const c of columns) {
      width = Math.max(width, 34 + options.measure(c.name, 'column') + 28 + options.measure(options.shortType(c.type), 'type') + 14)
    }
    return {
      id: tableId(table),
      table,
      columns,
      x: 0,
      y: 0,
      width: Math.round(Math.min(Math.max(width, 190), 460)),
      height: HEADER + Math.max(columns.length, 1) * ROW + FOOTER
    }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const edges: DiagramEdge[] = []
  for (const node of nodes) {
    node.columns.forEach((c, i) => {
      if (!c.fk) return
      const target = byId.get(`${c.fk.schema}.${c.fk.table}`)
      if (!target || !ids.has(target.id)) return
      const column = target.columns.findIndex((tc) => tc.name === c.fk!.column)
      edges.push({
        id: `${node.id}.${c.name}`,
        from: { node: node.id, column: i, nullable: c.nullable },
        to: { node: target.id, column: Math.max(column, 0) }
      })
    })
  }

  // Related tables get a layered layout, parents to the left of the tables that reference them.
  const related = new Set(edges.flatMap((e) => (e.from.node === e.to.node ? [] : [e.from.node, e.to.node])))
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110, marginx: 0, marginy: 0 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) if (related.has(n.id)) graph.setNode(n.id, { width: n.width, height: n.height })
  for (const e of edges) if (e.from.node !== e.to.node) graph.setEdge(e.to.node, e.from.node)
  let bottom = 0
  let right = 0
  if (related.size) {
    dagre.layout(graph)
    for (const n of nodes) {
      if (!related.has(n.id)) continue
      const placed = graph.node(n.id)
      n.x = Math.round(placed.x - n.width / 2)
      n.y = Math.round(placed.y - n.height / 2)
      bottom = Math.max(bottom, n.y + n.height)
      right = Math.max(right, n.x + n.width)
    }
  }

  // Tables without relationships go in rows underneath.
  const loose = nodes.filter((n) => !related.has(n.id)).sort((a, b) => a.id.localeCompare(b.id))
  const rowWidth = Math.max(right, 1400)
  let x = 0
  let y = related.size ? bottom + 90 : 0
  let rowHeight = 0
  for (const n of loose) {
    if (x > 0 && x + n.width > rowWidth) {
      x = 0
      y += rowHeight + 36
      rowHeight = 0
    }
    n.x = x
    n.y = y
    x += n.width + 36
    rowHeight = Math.max(rowHeight, n.height)
  }

  return { nodes, edges }
}

/** Where a column's row sits on a node's left or right edge. */
export function anchor(node: { x: number; y: number; width: number }, column: number, side: 'left' | 'right') {
  return { x: side === 'left' ? node.x : node.x + node.width, y: node.y + HEADER + column * ROW + ROW / 2 }
}
