/* ============================================================
   THE MARK — die-face with terminal cursor
   The active pip is replaced by a >_ prompt. Reads as both
   "tabletop exercise" (die) and "command line" (cursor).
   ============================================================ */

/**
 * Core mark. The 1-pip die face has its center pip swapped for a
 * terminal cursor (>_). At small sizes the cursor collapses to a
 * single block so the silhouette stays legible.
 *
 * @param {object} p
 * @param {number} p.size       px
 * @param {string} p.fg         foreground (die outline + cursor)
 * @param {string} p.bg         background fill
 * @param {string} p.accent     cursor block / caret color
 * @param {boolean} p.detailed  render the >_ prompt (true) or just a block (false)
 * @param {boolean} p.blink     animate the caret block
 * @param {number} p.radius     corner radius (0..0.32 of size)
 */
/* ------------------------------------------------------------
 * Pip configurations for the rolling state. Coordinates in the
 * 100-unit grid. The "prompt" face is our brand face — d6 rolls
 * always return to it. Other faces are real die-pip layouts so
 * the tumble reads as an actual die.
 * ------------------------------------------------------------ */
const PIP_R = 7;
const FACES = {
  // brand face — > and caret block in place of the center pip
  prompt: 'prompt',
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]],
};

/* ------------------------------------------------------------
 * Brand-face renderers. Each one replaces the d6 1-pip with a
 * security-domain glyph. All centered at (50,50) on the 100-grid.
 * ------------------------------------------------------------ */

function FaceRadar({ fg, accent, blink }) {
  return (
    <g>
      {/* outer rings (concentric, scope/threat-ring) */}
      <circle cx="50" cy="50" r="26" fill="none" stroke={fg} strokeWidth="2.5" opacity="0.85" />
      <circle cx="50" cy="50" r="17" fill="none" stroke={fg} strokeWidth="2.5" opacity="0.6" />
      {/* crosshair ticks */}
      <line x1="50" y1="14" x2="50" y2="22" stroke={fg} strokeWidth="3" />
      <line x1="50" y1="78" x2="50" y2="86" stroke={fg} strokeWidth="3" />
      <line x1="14" y1="50" x2="22" y2="50" stroke={fg} strokeWidth="3" />
      <line x1="78" y1="50" x2="86" y2="50" stroke={fg} strokeWidth="3" />
      {/* sweep wedge */}
      <path
        d="M 50 50 L 76 50 A 26 26 0 0 0 68 31.7 Z"
        fill={accent} opacity="0.85"
        style={blink ? { animation: 'tt-sweep 2.4s linear infinite', transformOrigin: '50px 50px' } : undefined}
      />
      {/* center dot */}
      <circle cx="50" cy="50" r="4" fill={accent} />
    </g>
  );
}

function FaceHexNode({ fg, accent, blink }) {
  // central hex node + 6 edge-nubs to neighbor nodes (attack graph hint)
  const hex = (cx, cy, r) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
    }
    return pts.join(' ');
  };
  return (
    <g>
      {/* edges first so node sits on top */}
      <line x1="50" y1="50" x2="22" y2="22" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      <line x1="50" y1="50" x2="78" y2="22" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      <line x1="50" y1="50" x2="14" y2="50" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      <line x1="50" y1="50" x2="86" y2="50" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      <line x1="50" y1="50" x2="22" y2="78" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      <line x1="50" y1="50" x2="78" y2="78" stroke={fg} strokeWidth="2.5" opacity="0.55" />
      {/* neighbor nodes */}
      <circle cx="22" cy="22" r="4" fill={fg} opacity="0.55" />
      <circle cx="78" cy="22" r="4" fill={fg} opacity="0.55" />
      <circle cx="14" cy="50" r="4" fill={fg} opacity="0.55" />
      <circle cx="86" cy="50" r="4" fill={fg} opacity="0.55" />
      <circle cx="22" cy="78" r="4" fill={fg} opacity="0.55" />
      <circle cx="78" cy="78" r="4" fill={fg} opacity="0.55" />
      {/* center hex node */}
      <polygon points={hex(50, 50, 16)} fill={accent} stroke={fg} strokeWidth="2.5" />
      <polygon points={hex(50, 50, 9)} fill="none" stroke={fg} strokeWidth="1.5" opacity="0.6" />
    </g>
  );
}

/* ------------------------------------------------------------
 * Playbook (chalkboard) — real Xs and Os in formation, with
 * loose hand-drawn curved routes ending in chevron arrowheads.
 * White chalk on dark-green board (the board is rendered by the
 * mark wrapper via fg/accent — for the brand, we paint the entire
 * face area chalkboard-green and switch fg to white).
 *
 * Composition (loosely a Wing-T):
 *   - 5 Os along a "line of scrimmage" in the upper third
 *   - 1 X (the runner) center-back
 *   - Two curved routes peeling out from outside Os
 *   - One straight route (the dive) from the X
 * All strokes are slightly imperfect: stroke-linecap round, and
 * the routes use bezier paths that mimic loose marker work.
 * ------------------------------------------------------------ */
/* ------------------------------------------------------------
 * THE PLAYBOOK
 *
 * The mark is a die. Every "roll" lands on a different play.
 * Each play is a composition of:
 *   players: array of {x, y, kind}  — kind is 'O' (line) or 'X' (runner)
 *   routes:  array of {d, color, head:{x,y,a}}  — bezier path + chevron
 *   id:      'CT/01'..'CT/06'
 *
 * Encounter maps use tabletop-RPG vocabulary: Os along a line as the party,
 * X for the threat (the variable in motion), and routes diagrammed in the same
 * register as a battle map. Six encounters = six die faces.
 * runner, curved routes ending in chevron arrowheads. Color
 * convention — the X and its route are signal-blue; the other
 * players and their routes are ink (white on dark, dark on light).
 *
 * Plays are designed to LIVE WITHIN A 100-UNIT DIE FACE with a
 * comfortable 14-unit padding (so they read at favicon size).
 * No chalkboard panel — the die itself is the surface.
 * ------------------------------------------------------------ */

const PLAYS = [
  /* CT/01 — Detect. The canonical encounter.
     5 party tokens on a line at y=38, threat back-center, 2 outside curls + a sweep right. */
  {
    id: 'CT/01',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 22 36 C 18 26, 14 20, 22 16',  color: 'fg',     head: { x: 22, y: 16, a: -95 } },
      { d: 'M 66 36 C 70 26, 74 20, 78 16',  color: 'fg',     head: { x: 78, y: 16, a: -75 } },
      { d: 'M 52 60 C 50 50, 60 42, 76 36',  color: 'accent', head: { x: 76, y: 36, a: -20 } },
    ],
  },
  /* CT/02 — Triage. Slant left.
     Same line, threat drives left across the formation. Outside party tokens crash inward. */
  {
    id: 'CT/02',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 22 44 C 26 54, 30 60, 38 60',  color: 'fg',     head: { x: 38, y: 60, a: 0 } },
      { d: 'M 66 44 C 62 54, 58 60, 50 64',  color: 'fg',     head: { x: 50, y: 64, a: 170 } },
      { d: 'M 48 60 C 40 56, 30 50, 18 36',  color: 'accent', head: { x: 18, y: 36, a: -130 } },
    ],
  },
  /* CT/03 — Contain. Option right.
     Threat cuts hard right, two outside party tokens drag downfield (vertical). */
  {
    id: 'CT/03',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 22 36 C 22 28, 22 22, 22 14',  color: 'fg',     head: { x: 22, y: 14, a: -90 } },
      { d: 'M 66 36 C 66 28, 66 22, 66 14',  color: 'fg',     head: { x: 66, y: 14, a: -90 } },
      { d: 'M 54 60 C 64 58, 72 54, 82 50',  color: 'accent', head: { x: 82, y: 50, a: -10 } },
    ],
  },
  /* CT/04 — Eradicate. Power up the middle.
     Threat drives straight up through the gap, lead party token pulls left to block. */
  {
    id: 'CT/04',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 44 36 C 40 30, 32 28, 24 28',  color: 'fg',     head: { x: 24, y: 28, a: 180 } },
      { d: 'M 50 56 C 50 42, 50 28, 50 16',  color: 'accent', head: { x: 50, y: 16, a: -90 } },
    ],
  },
  /* CT/05 — Recover. Wide sweep.
     Threat arcs all the way around the right end, two party tokens pull as blockers. */
  {
    id: 'CT/05',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 55 36 C 60 30, 70 26, 78 24',  color: 'fg',     head: { x: 78, y: 24, a: -65 } },
      { d: 'M 66 36 C 72 32, 80 30, 86 30',  color: 'fg',     head: { x: 86, y: 30, a: -10 } },
      { d: 'M 52 60 C 70 60, 82 50, 84 32',  color: 'accent', head: { x: 84, y: 32, a: -75 } },
    ],
  },
  /* CT/06 — Review. Counter.
     Threat fakes right then cuts back across the formation (S-curve). */
  {
    id: 'CT/06',
    players: [
      { x: 22, y: 40, kind: 'O' }, { x: 33, y: 40, kind: 'O' },
      { x: 44, y: 40, kind: 'O', emph: true },
      { x: 55, y: 40, kind: 'O' }, { x: 66, y: 40, kind: 'O' },
      { x: 50, y: 60, kind: 'X' },
    ],
    routes: [
      { d: 'M 22 36 C 26 28, 36 24, 44 22',  color: 'fg',     head: { x: 44, y: 22, a: -20 } },
      { d: 'M 66 36 C 62 28, 56 24, 48 22',  color: 'fg',     head: { x: 48, y: 22, a: -160 } },
      { d: 'M 52 58 C 64 52, 60 36, 30 22',  color: 'accent', head: { x: 30, y: 22, a: -150 } },
    ],
  },
];

/* Render one play directly on the die face (no chalkboard panel).
   `fg` is the line color, `accent` is the X / runner color. */
function FacePlay({ fg, accent, playIndex = 0, dim = false }) {
  const play = PLAYS[((playIndex % PLAYS.length) + PLAYS.length) % PLAYS.length];
  // dim is used during the brief tumble — fade everything to make the swap soft
  const opacity = dim ? 0 : 1;
  return (
    <g style={{ opacity, transition: 'opacity 180ms ease-out' }}>
      {/* faint line-of-scrimmage guide — same on every play, anchors the composition */}
      <line x1="14" y1="52" x2="86" y2="52"
        stroke={fg} strokeOpacity="0.18" strokeWidth="0.8" strokeDasharray="2 2" />

      {/* players */}
      {play.players.map((p, i) => (
        p.kind === 'O' ? (
          <circle key={i} cx={p.x} cy={p.y} r={p.emph ? 4.0 : 3.4}
            fill="none" stroke={fg} strokeWidth={p.emph ? 2.0 : 1.6} />
        ) : (
          <g key={i} stroke={accent} strokeWidth="2.4" strokeLinecap="round">
            <line x1={p.x - 4} y1={p.y - 4} x2={p.x + 4} y2={p.y + 4} />
            <line x1={p.x + 4} y1={p.y - 4} x2={p.x - 4} y2={p.y + 4} />
          </g>
        )
      ))}

      {/* routes */}
      {play.routes.map((r, i) => (
        <PlayRoute key={i}
          d={r.d}
          color={r.color === 'accent' ? accent : fg}
          ax={r.head.x} ay={r.head.y} angle={r.head.a}
        />
      ))}

      {/* play number — small, lower-right */}
      <text x="86" y="90" textAnchor="end"
        style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 7, fill: fg, fillOpacity: 0.55, letterSpacing: '0.1em' }}>
        {play.id}
      </text>
    </g>
  );
}

/* Backwards-compat shim: the old `FacePlaybookChalk` name still
   resolves, now points at the canonical Play 01 with no chalk panel. */
function FacePlaybookChalk({ fg, accent }) {
  return <FacePlay fg={fg} accent={accent} playIndex={0} />;
}

/* loose chalk route: bezier path + chevron arrowhead at (ax,ay) rotated by `angle` deg */
function PlayRoute({ d, color, angle, ax, ay }) {
  const head = 3.5;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <g transform={`translate(${ax} ${ay}) rotate(${angle})`}>
        <path
          d={`M 0 0 L ${head} ${head * 0.8} M 0 0 L ${head} ${-head * 0.8}`}
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </g>
  );
}

/* ------------------------------------------------------------
 * Morph face — animated transition between die-face-5 and the
 * top-down war-room table. Each die pip cross-fades into a chair
 * (corners) or the center target (center pip). Table outline and
 * dashed blindspot seat fade in during the table phase.
 *
 * Cycle (8s loop):
 *   0–25%   pure die (5 pips)
 *   25–45%  morph: pips fade out, chairs/target/table fade in
 *   45–70%  pure table
 *   70–90%  morph back
 *   90–100% pure die
 * ------------------------------------------------------------ */
function FaceMorph({ fg, accent }) {
  /* Quiet 12s loop with a 4-corner shared geometry:
     - 4 corner pips/seats stay PUT the entire time (just morph fill weight)
     - center pip cross-fades to a small open square (the "table" centerpiece)
     - table outline gently fades in around the seats
     One signal-accent seat (top-right) holds the whole way; the
     mark reads as die at rest, then table at rest, with a slow breath
     between. No motion, no rotation — just opacity. */
  return (
    <g className="tt-morph">
      <style>{`
        .tt-morph .table-outline { animation: tt-outline 12s ease-in-out infinite; }
        .tt-morph .center-pip    { animation: tt-cpip 12s ease-in-out infinite; }
        .tt-morph .center-square { animation: tt-csq 12s ease-in-out infinite; }
        @keyframes tt-outline {
          0%, 30%   { opacity: 0; }
          45%, 80%  { opacity: 1; }
          95%, 100% { opacity: 0; }
        }
        @keyframes tt-cpip {
          0%, 30%   { opacity: 1; }
          45%, 80%  { opacity: 0; }
          95%, 100% { opacity: 1; }
        }
        @keyframes tt-csq {
          0%, 30%   { opacity: 0; }
          45%, 80%  { opacity: 0.7; }
          95%, 100% { opacity: 0; }
        }
      `}</style>
      {/* shared corner seats — never move */}
      <circle cx="30" cy="30" r="4.6" fill={fg} />
      <circle cx="70" cy="30" r="4.6" fill={accent} />
      <circle cx="30" cy="70" r="4.6" fill={fg} />
      <circle cx="70" cy="70" r="4.6" fill={fg} />
      {/* table outline — fades in during table phase */}
      <rect className="table-outline" x="32" y="32" width="36" height="36" rx="4"
            fill="none" stroke={fg} strokeWidth="2" opacity="0" />
      {/* center: pip <-> tiny open square */}
      <circle className="center-pip" cx="50" cy="50" r="4.6" fill={fg} />
      <rect className="center-square" x="45" y="45" width="10" height="10" rx="1.4"
            fill="none" stroke={fg} strokeWidth="1.4" opacity="0" />
    </g>
  );
}
/* ------------------------------------------------------------
 * War-room table family — 6 layout variants, all sharing the
 * same vocabulary: rounded-rect table outline, circular "Os" for
 * seats (people, not chairs), a small d6 pip in the center
 * ("the thing on the table" → ties back to the dice metaphor),
 * one seat highlighted in signal-green which CYCLES around the
 * table over time via CSS animation. No empty/blindspot seat.
 *
 * Each variant: FaceTableLong, FaceTableRound, FaceTableBoardroom,
 * FaceTableSparse, FaceTableSquare, FaceTableAsym. The original
 * `table` brand alias points to FaceTableSquare (closest to the
 * d6's symmetry — strongest morph candidate).
 *
 * Animation strategy: each seat is given a class .seat-N and the
 * fill is animated in 6-step cycles so exactly one seat is signal
 * at a time. The cycle is 6s (1s per seat). Animation is omitted
 * when `animate={false}` (favicons, print, etc).
 * ------------------------------------------------------------ */
function tableSeatStyle(animate) {
  // Animation removed — seats are now static. One seat is in accent permanently
  // to read as "active speaker / whose turn." Kept the function shape so call
  // sites don't need to change.
  return null;
}

/* small d6-pip centerpiece — the "thing on the table" */
function CenterPip({ fg, accent, size = 4 }) {
  return (
    <g>
      {/* tiny rounded square (mini-die silhouette) */}
      <rect x={50 - size - 1} y={50 - size - 1} width={(size + 1) * 2} height={(size + 1) * 2} rx="1.4"
            fill="none" stroke={fg} strokeWidth="1.2" opacity="0.55" />
      {/* the pip itself */}
      <circle cx="50" cy="50" r={size * 0.65} fill={accent} />
    </g>
  );
}

function Seat({ cx, cy, r = 4.2, hot = false, fg, accent }) {
  return <circle cx={cx} cy={cy} r={r} fill={hot ? accent : fg} />;
}

/* V1 — Square table (4 sides × 2 seats = 8) — tightest die-rhyme */
function FaceTableSquare({ fg, accent, animate = true }) {
  const seats = [
    [38, 24], [62, 24],   // top
    [76, 38], [76, 62],   // right
    [62, 76], [38, 76],   // bottom (cycle goes clockwise)
  ];
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <rect x="32" y="32" width="36" height="36" rx="4" fill="none" stroke={fg} strokeWidth="2.5" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* V2 — Round table (6 evenly spaced) — collaborative */
function FaceTableRound({ fg, accent, animate = true }) {
  const seats = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    seats.push([50 + Math.cos(a) * 28, 50 + Math.sin(a) * 28]);
  }
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <circle cx="50" cy="50" r="18" fill="none" stroke={fg} strokeWidth="2.5" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* V3 — Long table (3 + 3 + 1 head) — conference room */
function FaceTableLong({ fg, accent, animate = true }) {
  const seats = [
    [32, 30], [50, 26], [68, 30],   // long sides + head — cycle goes around
    [82, 50],                         // head (right)
    [68, 70], [50, 74], [32, 70],   // bottom row
  ].slice(0, 6); // keep to 6 for cycle
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <rect x="22" y="38" width="56" height="24" rx="3" fill="none" stroke={fg} strokeWidth="2.5" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* V4 — Boardroom (4 + 4, no head) — long rectangular */
function FaceTableBoardroom({ fg, accent, animate = true }) {
  const seats = [
    [28, 32], [44, 28], [56, 28], [72, 32],   // top row (cycle clockwise)
    [72, 68], [56, 72], [44, 72], [28, 68],   // bottom
  ].slice(0, 6);
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <rect x="22" y="40" width="56" height="20" rx="3" fill="none" stroke={fg} strokeWidth="2.5" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* V5 — Sparse (1 per side, 4 total) — quiet & modern */
function FaceTableSparse({ fg, accent, animate = true }) {
  const seats = [[50, 22], [78, 50], [50, 78], [22, 50]];
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <rect x="32" y="32" width="36" height="36" rx="4" fill="none" stroke={fg} strokeWidth="2.5" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} r={4.6} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* V6 — Asymmetric cluster (5 in conversation) */
function FaceTableAsym({ fg, accent, animate = true }) {
  const seats = [
    [30, 30], [50, 24], [70, 30],
    [70, 72], [30, 72],
  ];
  return (
    <g style={{ '--tt-fg': fg, '--tt-accent': accent }}>
      {tableSeatStyle(animate)}
      <path d="M 30 40 Q 50 36 70 40 L 70 60 Q 50 64 30 60 Z" fill="none" stroke={fg} strokeWidth="2.5" strokeLinejoin="round" />
      {seats.map(([x, y], i) => <Seat key={i} cx={x} cy={y} idx={i + 1} animate={animate} />)}
      <CenterPip fg={fg} accent={accent} />
    </g>
  );
}

/* Default `table` brand alias — points to the square variant (most die-like) */
function FaceTable({ fg, accent }) {
  return <FaceTableSquare fg={fg} accent={accent} animate={true} />;
}

/* ------------------------------------------------------------
 * Sticky note — a single signal-green square with a slight tilt
 * and a curled corner. Reads as workshop/facilitation.
 * ------------------------------------------------------------ */
function FaceSticky({ fg, accent }) {
  return (
    <g transform="rotate(-6 50 50)">
      {/* note body */}
      <rect x="28" y="28" width="44" height="44" fill={accent} />
      {/* curled corner shadow */}
      <polygon points="64,28 72,28 72,36" fill={fg} opacity="0.18" />
      {/* three lines of "writing" */}
      <line x1="34" y1="40" x2="60" y2="40" stroke={fg} strokeWidth="2" opacity="0.45" />
      <line x1="34" y1="48" x2="64" y2="48" stroke={fg} strokeWidth="2" opacity="0.45" />
      <line x1="34" y1="56" x2="52" y2="56" stroke={fg} strokeWidth="2" opacity="0.45" />
    </g>
  );
}

/* ------------------------------------------------------------
 * Inject envelope — sealed envelope with a number, like the
 * paper injects a facilitator drops on the table mid-exercise.
 * ------------------------------------------------------------ */
function FaceEnvelope({ fg, accent }) {
  return (
    <g>
      {/* envelope body */}
      <rect x="22" y="32" width="56" height="36" rx="2" fill="none" stroke={fg} strokeWidth="2.5" />
      {/* flap (V) */}
      <path d="M 22 32 L 50 52 L 78 32" fill="none" stroke={fg} strokeWidth="2.5" strokeLinejoin="miter" />
      {/* wax-seal dot, signal-green */}
      <circle cx="50" cy="60" r="5" fill={accent} />
      {/* tiny "01" embossed — abstracted as two ticks */}
      <line x1="47" y1="58" x2="47" y2="62" stroke={fg} strokeWidth="1.2" opacity="0.5" />
      <line x1="51" y1="58" x2="53" y2="62" stroke={fg} strokeWidth="1.2" opacity="0.5" />
    </g>
  );
}

/* small utility — draws a line with a chevron arrowhead at (x2,y2) */
function Arrow({ x1, y1, x2, y2, color }) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len, uy = dy / len;
  // back up the head a bit so the line meets the tip
  const hx = x2 - ux * 4, hy = y2 - uy * 4;
  // perpendicular for the head wings
  const px = -uy, py = ux;
  const w = 3.2;
  return (
    <g>
      <line x1={x1} y1={y1} x2={hx} y2={hy} stroke={color} strokeWidth="2" strokeLinecap="round" />
      <polygon
        points={`${x2},${y2} ${hx + px*w},${hy + py*w} ${hx - px*w},${hy - py*w}`}
        fill={color}
      />
    </g>
  );
}

function FaceContent({ face, fg, accent, blink, brand, playIndex = 0, dim = false }) {
  if (face === 'prompt') {
    if (brand === 'radar')    return <FaceRadar fg={fg} accent={accent} blink={blink} />;
    if (brand === 'hex')      return <FaceHexNode fg={fg} accent={accent} blink={blink} />;
    if (brand === 'table')          return <FaceTable fg={fg} accent={accent} />;
    if (brand === 'table-square')   return <FaceTableSquare fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'table-round')    return <FaceTableRound fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'table-long')     return <FaceTableLong fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'table-boardroom')return <FaceTableBoardroom fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'table-sparse')   return <FaceTableSparse fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'table-asym')     return <FaceTableAsym fg={fg} accent={accent} animate={blink !== false} />;
    if (brand === 'sticky')   return <FaceSticky fg={fg} accent={accent} />;
    if (brand === 'envelope') return <FaceEnvelope fg={fg} accent={accent} />;
    if (brand === 'morph')    return <FaceMorph fg={fg} accent={accent} />;
    if (brand === 'playbook') return <FacePlay fg={fg} accent={accent} playIndex={playIndex} dim={dim} />;
    // legacy "cursor" face — kept for back-compat but no longer the brand
    return (
      <g>
        <path
          d="M 30 38 L 44 50 L 30 62"
          fill="none" stroke={fg} strokeWidth="7"
          strokeLinecap="square" strokeLinejoin="miter"
        />
        <rect
          x="52" y="56" width="18" height="10" fill={accent}
          style={blink ? { animation: 'tt-blink 1s steps(2) infinite' } : undefined}
        />
      </g>
    );
  }
  return (
    <g style={{ opacity: dim ? 0 : 1, transition: 'opacity 180ms ease-out' }}>
      {FACES[face].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={PIP_R} fill={fg} />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------
 * Hook: drive the rolling state. Default behavior is a periodic
 * subtle tumble — every ~6s, the die wobbles for ~700ms cycling
 * through faces 2→5→3→6→prompt, then sits still. We keep the
 * tumble small (±4deg) so it reads as a *fidget*, not a roll.
 * ------------------------------------------------------------ */
/* ------------------------------------------------------------
 * Hook: drive the roll animation. Every `period` ms, the die
 * tumbles (~600ms) and lands on the NEXT play in the playbook.
 * The play swap happens mid-tumble so the new play "appears"
 * as the die comes to rest. State machine:
 *   rest        — at angle 0, scale 1, current play visible
 *   tumble.up   — angle -10, scale 0.94, play dim          (180ms)
 *   tumble.swap — angle +8,  scale 0.96, play SWAPPED, dim (160ms)
 *   tumble.land — angle  0,  scale 1.02, play visible      (140ms)
 *   settle      — angle  0,  scale 1                       (continues)
 * `face` is always 'prompt' for the playbook brand — the brand
 * face renders FacePlay (no pip-face fallbacks). For other brands
 * the face cycles through 2/5/3/6 like before (legacy behavior).
 * ------------------------------------------------------------ */
function useRoll({ enabled = true, period = 6000, isPlaybook = true, playCount = 6 } = {}) {
  const [state, setState] = React.useState({
    face: 'prompt', angle: 0, scale: 1, playIndex: 0, dim: false,
    showFace: false, // when true, render the numbered die face N+1 instead of the play
  });
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let i = 0;          // current play index
    let phase = 'play'; // 'play' = showing play N, 'face' = showing die face N+1
    const sequence = async () => {
      while (!cancelled) {
        await wait(period);
        if (cancelled) return;
        if (isPlaybook) {
          // tumble.up — current state dims out
          setState(s => ({ ...s, angle: -10, scale: 0.94, dim: true }));
          await wait(180); if (cancelled) return;
          // tumble.swap — pick the new state behind the dim curtain
          if (phase === 'play') {
            // we were showing play N, now show numbered die face N+1
            setState(s => ({ ...s, angle: 8, scale: 0.96, dim: true, showFace: true, face: ((i + 1) % playCount) + 1 }));
            phase = 'face';
          } else {
            // we were showing the numbered face, now show play (advance i first)
            i = (i + 1) % playCount;
            setState(s => ({ ...s, angle: 8, scale: 0.96, dim: true, showFace: false, playIndex: i, face: 'prompt' }));
            phase = 'play';
          }
          await wait(160); if (cancelled) return;
          // tumble.land — the new state reveals as die settles
          setState(s => ({ ...s, angle: 0, scale: 1.02, dim: false }));
          await wait(140); if (cancelled) return;
          setState(s => ({ ...s, angle: 0, scale: 1 }));
        } else {
          // Legacy fidget for non-playbook brands
          const order = [2, 5, 3, 6, 'prompt'];
          const angles = [-3, 4, -2, 3, 0];
          const scales = [0.96, 1.02, 0.98, 1.01, 1];
          for (let j = 0; j < order.length; j++) {
            if (cancelled) return;
            setState({ face: order[j], angle: angles[j], scale: scales[j], playIndex: 0, dim: false, showFace: false });
            await wait(140);
          }
        }
      }
    };
    sequence();
    return () => { cancelled = true; };
  }, [enabled, period, isPlaybook, playCount]);
  return state;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function Mark({
  size = 96,
  fg = "var(--ink-100)",
  bg = "var(--ink-900)",
  accent = "var(--signal)",
  detailed = true,
  blink = false,
  radius = 0.22,
  stroke = 0.06,
  roll = false,        // animate the periodic tumble
  rollPeriod = 6000,
  brand = "playbook",     // 'radar' | 'hex' | 'playbook' | 'table' | 'table-*' | 'sticky' | 'envelope' | 'morph'
  playIndex = 0,         // for brand="playbook", which play to render at rest
}) {
  const r = size * radius;
  const sw = size * stroke;
  const isPlaybook = brand === 'playbook';
  const rollState = useRoll({
    enabled: roll && detailed,
    period: rollPeriod,
    isPlaybook,
    playCount: PLAYS.length,
  });
  const face = roll && detailed ? rollState.face : 'prompt';
  const angle = roll && detailed ? rollState.angle : 0;
  const scale = roll && detailed ? rollState.scale : 1;
  const activePlay = roll && detailed && isPlaybook ? rollState.playIndex : playIndex;
  const dim = roll && detailed && isPlaybook ? rollState.dim : false;
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 100 100"
      style={{
        display: 'block',
        transform: `rotate(${angle}deg) scale(${scale})`,
        transformOrigin: 'center',
        transition: 'transform 140ms cubic-bezier(.4,.0,.4,1)',
      }}
      aria-label="Mark"
    >
      <defs>
        <clipPath id={`mclip-${size}`}>
          <rect x="0" y="0" width="100" height="100" rx={r * 100/size} ry={r * 100/size} />
        </clipPath>
      </defs>
      <rect
        x={sw * 100/size / 2}
        y={sw * 100/size / 2}
        width={100 - sw * 100/size}
        height={100 - sw * 100/size}
        rx={r * 100/size}
        ry={r * 100/size}
        fill={bg} stroke={fg} strokeWidth={sw * 100/size}
      />
      {detailed ? (
        <g clipPath={`url(#mclip-${size})`}>
          <FaceContent face={face} fg={fg} accent={accent} blink={blink} brand={brand} playIndex={activePlay} dim={dim} />
        </g>
      ) : (
        <rect x="40" y="40" width="20" height="20" rx="3" fill={accent} />
      )}
    </svg>
  );
}

/**
 * Wordmark + mark lockup. Wordmark uses JetBrains Mono so the brand
 * voice is unambiguous: we are an operator-grade product, not a
 * lifestyle app. The product name (Crittable) renders in tracked-out caps.
 */
function Lockup({
  name = "ACME",
  size = 64,
  fg = "var(--ink-100)",
  bg = "var(--ink-900)",
  accent = "var(--signal)",
  blink = false,
  detailed = true,
  layout = "horizontal",
  showSlogan = false,
  roll = false,
  rollPeriod = 6000,
  brand = "playbook",
}) {
  if (layout === "stacked") {
    return (
      <div style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: size * 0.16,
        color: fg,
      }}>
        <Mark size={size} fg={fg} bg={bg} accent={accent} blink={blink} detailed={detailed} roll={roll} rollPeriod={rollPeriod} brand={brand} />
        <div style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontWeight: 700,
          fontSize: size * 0.36,
          letterSpacing: '0.18em',
          color: fg,
          textTransform: 'uppercase',
        }}>{name}</div>
        {showSlogan ? (
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontWeight: 500,
            fontSize: size * 0.16,
            letterSpacing: '0.32em',
            color: 'var(--ink-200)',
            textTransform: 'uppercase',
          }}>roll · respond · review</div>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: size * 0.28,
      color: fg,
    }}>
      <Mark size={size} fg={fg} bg={bg} accent={accent} blink={blink} detailed={detailed} roll={roll} rollPeriod={rollPeriod} brand={brand} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.04 }}>
        <div style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontWeight: 700,
          fontSize: size * 0.42,
          letterSpacing: '0.14em',
          color: fg,
          textTransform: 'uppercase',
          lineHeight: 1,
        }}>{name}</div>
        {showSlogan ? (
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontWeight: 500,
            fontSize: size * 0.14,
            letterSpacing: '0.30em',
            color: 'var(--ink-200)',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}>roll · respond · review</div>
        ) : null}
      </div>
    </div>
  );
}

Object.assign(window, { Mark, Lockup, PLAYS });
