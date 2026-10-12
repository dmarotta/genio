import { cx } from '../lib/format'

/**
 * Genio's avatar: a hex reactor core. Idle it breathes; active it spins up,
 * orbiters fly and the eye scans. Pure SVG + CSS, no assets.
 */
export function GenioCore({ size = 48, state = 'idle' }: { size?: number; state?: 'idle' | 'active' | 'alert' | 'off' }) {
  const hex = (r: number): string =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2
      return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`
    }).join(' ')
  return (
    <svg className={cx('core', `core-${state}`)} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--core-c)" stopOpacity="0.9" />
          <stop offset="60%" stopColor="var(--core-c)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--core-c)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill="url(#coreGlow)" className="core-halo" />
      <g className="core-outer">
        <polygon points={hex(44)} fill="none" stroke="var(--core-c)" strokeWidth="2" strokeDasharray="14 7" />
      </g>
      <g className="core-inner">
        <polygon points={hex(30)} fill="rgba(0,0,0,0.55)" stroke="var(--core-c)" strokeWidth="2.5" />
      </g>
      <g className="core-orbit">
        <rect x="47" y="1" width="6" height="6" fill="var(--core-c)" />
        <rect x="47" y="93" width="6" height="6" fill="var(--core-c)" opacity="0.6" />
      </g>
      <g className="core-eye">
        <rect x="38" y="44" width="24" height="12" fill="var(--core-c)" />
        <rect x="44" y="47" width="6" height="6" fill="#05060a" className="core-pupil" />
      </g>
    </svg>
  )
}
