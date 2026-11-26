import { useId, useRef, useState } from 'react';
import { ZONES, ZONE_LABEL, shadeOf, type Side, type Zone, type ZoneStats } from '../lib/impact';
import { SEQ_BLUE, rampColor, textOn } from '../lib/ramp';
import { ui, type Mode } from '../theme';

// Top-down car, nose up. Zones are clipped to the body so the grid reads as a car, not as a table.
const BODY =
  'M120 12C168 12 190 40 192 90L196 150L198 300L192 370C188 410 160 428 120 428C80 428 52 410 48 370L42 300L44 150L48 90C50 40 72 12 120 12Z';
const RECT: Record<Exclude<Zone, 'bottom'>, [number, number, number, number]> = {
  front_left: [0, 0, 80, 140],
  front: [80, 0, 80, 140],
  front_right: [160, 0, 80, 140],
  left: [0, 140, 80, 160],
  top: [80, 140, 80, 160],
  right: [160, 140, 80, 160],
  rear_left: [0, 300, 80, 150],
  rear: [80, 300, 80, 150],
  rear_right: [160, 300, 80, 150],
};
const LABEL_POS: Record<Exclude<Zone, 'bottom'>, [number, number]> = {
  front_left: [66, 104], front: [120, 62], front_right: [174, 104], left: [62, 222], top: [120, 222], right: [179, 222],
  rear_left: [66, 350], rear: [120, 376], rear_right: [174, 350],
};
export const LOW_N = 10;

export function CarOutline({
  title,
  stats,
  mode,
  selected,
  onSelect,
  maxShare,
}: {
  title: string;
  stats: ZoneStats;
  mode: Mode;
  selected: Zone | null;
  onSelect: (z: Zone | null) => void;
  maxShare: number;
}) {
  const t = ui(mode);
  const id = useId().replace(/:/g, '');
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ z: Zone; x: number; y: number } | null>(null);
  const ramp = SEQ_BLUE[mode];

  const share = (z: Zone) => (stats.known > 0 ? stats.counts[z] / stats.known : 0);
  const fillOf = (z: Zone) => rampColor(ramp, shadeOf(share(z), maxShare) * 0.92 + 0.04);
  const place = (e: { clientX: number; clientY: number }, z: Zone) => {
    const r = wrap.current!.getBoundingClientRect();
    setTip({ z, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const placeAtZone = (el: Element, z: Zone) => {
    const r = wrap.current!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    setTip({ z, x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height / 2 });
  };
  const label = (z: Zone) => `${ZONE_LABEL[z]}: ${stats.counts[z]} crashes, ${(share(z) * 100).toFixed(1)}% of ${stats.known} with a known area`;

  const zoneProps = (z: Zone) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': selected === z,
    'aria-label': label(z),
    onMouseEnter: (e: React.MouseEvent) => place(e, z),
    onMouseMove: (e: React.MouseEvent) => place(e, z),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => placeAtZone(e.currentTarget, z),
    onBlur: () => setTip(null),
    onClick: () => onSelect(selected === z ? null : z),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(selected === z ? null : z);
      }
      if (e.key === 'Escape') setTip(null);
    },
    style: { cursor: 'pointer', outline: 'none' } as React.CSSProperties,
  });

  const zoneShape = (z: Zone) => {
    const fill = fillOf(z);
    const low = stats.counts[z] < LOW_N;
    const on = selected === z;
    const pct = stats.known > 0 ? `${(share(z) * 100).toFixed(share(z) >= 0.1 ? 0 : 1)}%` : '';
    const common = { fill, stroke: t.surface, strokeWidth: 2 };
    if (z === 'bottom') {
      return (
        <g key={z} {...zoneProps(z)} className="zone">
          <rect x={52} y={446} width={136} height={36} rx={8} {...common} />
          {low && <rect x={52} y={446} width={136} height={36} rx={8} fill={`url(#hatch${id})`} pointerEvents="none" />}
          <rect x={52} y={446} width={136} height={36} rx={8} fill="none" stroke={on ? t.ink : 'transparent'} strokeWidth={3} className="zone-ring" pointerEvents="none" />
          <text x={120} y={468} textAnchor="middle" fontSize={12} fontWeight={600} fill={textOn(fill)} pointerEvents="none">
            Underbody {pct}
          </text>
        </g>
      );
    }
    const [x, y, w, h] = RECT[z];
    const [lx, ly] = LABEL_POS[z];
    return (
      <g key={z} {...zoneProps(z)} className="zone">
        <rect x={x} y={y} width={w} height={h} {...common} />
        {low && <rect x={x} y={y} width={w} height={h} fill={`url(#hatch${id})`} pointerEvents="none" />}
        <rect x={x} y={y} width={w} height={h} fill="none" stroke={on ? t.ink : 'transparent'} strokeWidth={4} className="zone-ring" pointerEvents="none" />
        <text x={lx} y={ly} textAnchor="middle" fontSize={z === 'left' || z === 'right' || z.includes('_') ? 12.5 : 14} fontWeight={700} fill={textOn(fill)} pointerEvents="none">
          {pct}
        </text>
        <text x={lx} y={ly + 15} textAnchor="middle" fontSize={10.5} fill={textOn(fill)} pointerEvents="none">
          {stats.counts[z]}
        </text>
      </g>
    );
  };

  const zbody = ZONES.filter((z) => z !== 'bottom');
  return (
    <figure className="car" ref={wrap}>
      <figcaption>
        <span className="panel-title">{title}</span>
        <span className="small">
          {stats.known.toLocaleString('en-US')} crashes with a known area, {stats.unknown.toLocaleString('en-US')} without
        </span>
      </figcaption>
      <svg viewBox="0 0 240 490" role="group" aria-label={`${title}: contact zones, nose up`} className="car-svg">
        <defs>
          <clipPath id={`body${id}`}>
            <path d={BODY} />
          </clipPath>
          <pattern id={`hatch${id}`} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={8} stroke={textOn(rampColor(ramp, 0.2))} strokeWidth={2} opacity={0.35} />
          </pattern>
        </defs>
        <path d="M44 100L26 96L26 138L45 140Z M196 100L214 96L214 138L195 140Z M44 320L24 316L24 366L46 368Z M196 320L216 316L216 366L194 368Z" fill={t.faint} opacity={0.45} />
        <g clipPath={`url(#body${id})`}>{zbody.map(zoneShape)}</g>
        <path d={BODY} fill="none" stroke={t.ink} strokeWidth={2} pointerEvents="none" />
        <path d="M70 128L170 128L162 156L78 156Z M78 292L162 292L170 316L70 316Z" fill="none" stroke={t.ink} strokeWidth={1.2} opacity={0.5} pointerEvents="none" />
        <text x={120} y={32} textAnchor="middle" fontSize={9} fill={t.ink} opacity={0.6} pointerEvents="none">FRONT</text>
        <text x={120} y={422} textAnchor="middle" fontSize={9} fill={t.ink} opacity={0.6} pointerEvents="none">REAR</text>
        {zoneShape('bottom')}
      </svg>
      {tip && (
        <div className="tip car-tip" role="status" style={{ left: Math.min(tip.x + 14, Math.max(8, (wrap.current?.clientWidth ?? 300) - 178)), top: Math.max(4, tip.y - 10) }}>
          <b>{ZONE_LABEL[tip.z]}</b>
          <span>
            {stats.counts[tip.z].toLocaleString('en-US')} crashes, {(share(tip.z) * 100).toFixed(1)}%
          </span>
          <span>of {stats.known.toLocaleString('en-US')} with a known area</span>
          {stats.counts[tip.z] < LOW_N && <span>Under {LOW_N} crashes: rough</span>}
        </div>
      )}
    </figure>
  );
}
