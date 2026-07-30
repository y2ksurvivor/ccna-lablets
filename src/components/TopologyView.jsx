// SVG topology. Click a node to open that device's console. Routers/switches
// render as rounded boxes, hosts as monitors. Active device is highlighted.
export default function TopologyView({ layout, devices, active, onSelect }) {
  const pos = Object.fromEntries(layout.nodes.map(n => [n.id, n]))
  const W = 620, H = 210

  return (
    <div className="topo">
      <svg viewBox={`0 0 ${W} ${H}`} className="topo-svg" preserveAspectRatio="xMidYMid meet">
        {layout.edges.map(([a, b], i) => {
          const pa = pos[a], pb = pos[b]
          if (!pa || !pb) return null
          return (
            <line key={i} x1={pa.x + 26} y1={pa.y + 18} x2={pb.x + 26} y2={pb.y + 18}
              className="topo-edge" />
          )
        })}
        {layout.nodes.map(n => {
          const dev = devices[n.id]
          const kind = dev?.kind || 'switch'
          const isActive = n.id === active
          const label = n.label || dev?.hostname || n.id
          return (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}
              className={`topo-node ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(n.id)}>
              <rect width="52" height="36" rx={kind === 'host' ? 3 : 8}
                className={`topo-box topo-${kind}`} />
              <text x="26" y="21" className="topo-icon">
                {kind === 'router' ? '⟲' : kind === 'switch' ? '⇄' : '🖥'}
              </text>
              {label.split('\n').map((ln, i) => (
                <text key={i} x="26" y={52 + i * 12} className="topo-label">{ln}</text>
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
