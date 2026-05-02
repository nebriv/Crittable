/* ============================================================
   Brand-package artboards. Each component renders one card on
   the design canvas.

   NAMING: locked. The product is Crittable — a compound of
   crit (the natural-20 critical hit / inject_critical_event /
   security-ops shorthand for a critical alert) and table
   (tabletop exercise). One word, leading capital in prose,
   tracked-out caps in the wordmark. See the NamingNote
   artboard for the full etymology.
*/

const PLACEHOLDER = "CRITTABLE"; // product name (locked)

const SLOGAN = "ROLL · RESPOND · REVIEW";

/* ----------------------------------------------------------- */

function ArtboardSurface({ children, padding = 64, bg = "var(--ink-900)" }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      background: bg,
      padding,
      boxSizing: 'border-box',
      position: 'relative',
      overflow: 'hidden',
    }}>{children}</div>
  );
}

function Eyebrow({ children, color = 'var(--ink-300)' }) {
  return (
    <div className="mono" style={{
      fontSize: 11,
      letterSpacing: '0.24em',
      color,
      textTransform: 'uppercase',
      fontWeight: 600,
    }}>{children}</div>
  );
}

function Caption({ children, color = 'var(--ink-300)' }) {
  return (
    <div className="mono" style={{
      fontSize: 11, color, letterSpacing: '0.04em', lineHeight: 1.4,
    }}>{children}</div>
  );
}

/* ============================================================
   01 — COVER
*/
function BrandCover() {
  return (
    <ArtboardSurface padding={0}>
      <div className="linegrid" style={{
        position: 'absolute', inset: 0, opacity: 0.6,
      }} />
      <div style={{
        position: 'relative', zIndex: 1,
        height: '100%', padding: 64,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 48,
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Eyebrow color="var(--signal)">brand package · v1</Eyebrow>
          <h1 className="mono" style={{
            fontSize: 56, fontWeight: 700, lineHeight: 0.95,
            letterSpacing: '-0.01em',
            color: 'var(--ink-050)',
            margin: 0,
          }}>
            An operator-grade<br/>
            tabletop for<br/>
            <span style={{ color: 'var(--signal)' }}>cybersecurity teams.</span>
          </h1>
          <p className="sans" style={{
            fontSize: 18, color: 'var(--ink-200)', lineHeight: 1.5,
            maxWidth: 460, margin: 0,
          }}>
            AI-facilitated incident-response drills. Deterministic injects,
            synthetic logs, per-role scoring. No PowerPoint, no roleplay
            theater — just the work.
          </p>
          <div style={{ display: 'flex', gap: 20, marginTop: 8 }}>
            <div>
              <Eyebrow>placeholder name</Eyebrow>
              <div className="mono" style={{
                fontSize: 22, fontWeight: 700, color: 'var(--ink-100)',
                letterSpacing: '0.08em', marginTop: 4,
              }}>{PLACEHOLDER}</div>
            </div>
            <div>
              <Eyebrow>tagline</Eyebrow>
              <div className="mono" style={{
                fontSize: 14, fontWeight: 600, color: 'var(--signal)',
                letterSpacing: '0.18em', marginTop: 6,
              }}>{SLOGAN}</div>
            </div>
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 32,
        }}>
          <Mark size={280} blink={false} roll={true} rollPeriod={3500} brand="playbook" />
          <Caption color="var(--ink-400)">
            // the mark · roll the die, run the play
          </Caption>
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   02 — NAMING NOTE
*/
function NamingNote() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">02 · naming</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 32, color: 'var(--ink-050)', fontWeight: 700,
            margin: '8px 0 0', letterSpacing: '-0.005em',
          }}>Crittable.</h2>
        </div>
        <p className="sans" style={{
          fontSize: 15, color: 'var(--ink-200)', lineHeight: 1.55, maxWidth: 720, margin: 0,
        }}>
          A compound: <span className="mono" style={{ color: 'var(--signal)' }}>crit</span> + <span className="mono" style={{ color: 'var(--signal)' }}>table</span>.
          <br /><br />
          <strong style={{ color: 'var(--ink-100)' }}>Crit</strong> — the natural-20 critical hit. The engine's <span className="mono">inject_critical_event</span> tool. Security-ops shorthand for a critical alert. Three readings, all live at once.
          <br /><br />
          <strong style={{ color: 'var(--ink-100)' }}>Table</strong> — places the product unambiguously in the <em>tabletop exercise</em> category. Not metaphor; literal taxonomy.
          <br /><br />
          The compound is distinctive, ownable, googleable, and culturally fluent for the actual buyer (security teams who are also tabletop-RPG players). One word, leading capital only: <span className="mono">Crittable</span> in prose, <span className="mono">CRITTABLE</span> in the wordmark, <span className="mono">crittable</span> in URLs.
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 24,
          marginTop: 12,
        }}>
          <div style={{
            border: '1px solid var(--ink-600)',
            background: 'var(--ink-850)',
            padding: '20px 24px',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gridColumn: '1 / -1',
          }}>
            <Lockup name={PLACEHOLDER} size={56} showSlogan />
          </div>
          <div style={{
            border: '1px solid var(--ink-600)',
            background: 'var(--ink-850)',
            padding: '20px 24px', borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
          }}>
            <Lockup name={PLACEHOLDER} size={36} />
            <Caption color="var(--ink-400)">9 char · header</Caption>
          </div>
          <div style={{
            border: '1px solid var(--ink-600)',
            background: 'var(--paper-050)',
            padding: '20px 24px', borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
          }}>
            <Lockup name={PLACEHOLDER} size={36}
              bg="var(--paper-050)" fg="var(--ink-900)" accent="var(--signal-deep)" />
            <Caption color="var(--ink-500)">paper · print</Caption>
          </div>
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   03 — MARK CONSTRUCTION
   Show the mark on a measured grid so the geometry is legible.
*/
function MarkConstruction() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">03 · the mark</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700,
            margin: '8px 0 0',
          }}>Roll the die. Run the play.</h2>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
          gap: 48,
          alignItems: 'center',
        }}>
          {/* construction diagram — the playbook chalkboard, dissected */}
          <div style={{
            position: 'relative',
            background: 'var(--ink-850)',
            border: '1px solid var(--ink-600)',
            borderRadius: 4,
            padding: 32,
            aspectRatio: '1 / 1',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block' }}>
              {/* construction grid */}
              {[10,20,30,40,50,60,70,80,90].map(v => (
                <g key={v}>
                  <line x1={v} y1="0" x2={v} y2="100" stroke="rgba(255,255,255,0.05)" strokeWidth="0.2" />
                  <line x1="0" y1={v} x2="100" y2={v} stroke="rgba(255,255,255,0.05)" strokeWidth="0.2" />
                </g>
              ))}

              {/* the die — rounded square, no inner panel */}
              <rect x="3" y="3" width="94" height="94" rx="22" ry="22"
                fill="var(--ink-900)" stroke="var(--ink-100)" strokeWidth="3" />

              {/* line-of-scrimmage guide (where the Os sit) */}
              <line x1="14" y1="52" x2="86" y2="52" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" strokeDasharray="2 2" />

              {/* 5 Os along the line at y=40 */}
              {[22, 33, 44, 55, 66].map((x, i) => (
                <circle key={i} cx={x} cy="40" r="3.4" fill="none" stroke="var(--ink-100)" strokeWidth="1.6" />
              ))}
              {/* center O emphasized — the snap */}
              <circle cx="44" cy="40" r="4.0" fill="none" stroke="var(--ink-100)" strokeWidth="2" />

              {/* The X — runner */}
              <g stroke="var(--signal)" strokeWidth="2.4" strokeLinecap="round">
                <line x1="46" y1="56" x2="54" y2="64" />
                <line x1="54" y1="56" x2="46" y2="64" />
              </g>

              {/* Routes — Play 01 */}
              <path d="M 22 36 C 18 26, 14 20, 22 16" fill="none" stroke="var(--ink-100)" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M 66 36 C 70 26, 74 20, 78 16" fill="none" stroke="var(--ink-100)" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M 52 60 C 50 50, 60 42, 76 36" fill="none" stroke="var(--signal)" strokeWidth="1.6" strokeLinecap="round" />

              {/* arrowhead callout markers */}
              <g transform="translate(22 16) rotate(-95)">
                <path d="M 0 0 L 3.5 2.8 M 0 0 L 3.5 -2.8" stroke="var(--ink-100)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </g>
              <g transform="translate(78 16) rotate(-75)">
                <path d="M 0 0 L 3.5 2.8 M 0 0 L 3.5 -2.8" stroke="var(--ink-100)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </g>
              <g transform="translate(76 36) rotate(-20)">
                <path d="M 0 0 L 3.5 2.8 M 0 0 L 3.5 -2.8" stroke="var(--signal)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </g>

              {/* play number */}
              <text x="86" y="90" textAnchor="end"
                style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 7, fill: 'var(--ink-100)', fillOpacity: 0.55, letterSpacing: '0.1em' }}>
                CT/01
              </text>

              {/* measurement ticks */}
              <circle cx="3" cy="3" r="1" fill="var(--signal)" />
              <circle cx="97" cy="3" r="1" fill="var(--signal)" />
              <circle cx="3" cy="97" r="1" fill="var(--signal)" />
              <circle cx="97" cy="97" r="1" fill="var(--signal)" />
            </svg>
            {/* callouts */}
            <div className="mono" style={{
              position: 'absolute', top: 12, right: 12,
              fontSize: 9, color: 'var(--signal)',
            }}>r = 0.22 · stroke = 3</div>
            <div className="mono" style={{
              position: 'absolute', bottom: 12, left: 12,
              fontSize: 9, color: 'var(--ink-400)',
            }}>100 × 100 unit grid · Encounter CT/01</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              ['The die', 'Rounded square, 22% corner radius, 3-unit stroke. The play is drawn directly on the die face — no inner panel, no chalkboard. The die IS the surface.'],
              ['Line of Os', 'Five 3.4-unit open circles at y=40 — the offensive line. Center O bumps to 4.0 (the snap). It\'s a team. Tabletop exercises are a team sport.'],
              ['The X', 'Two crossed strokes at center-back, signal-blue. The runner. The thing in motion. The variable everyone else is reacting to.'],
              ['Three routes', 'Loose bezier curves with chevron heads. Ink for the line; signal-blue for the X. Plays 01–06 each use a different route shape, but the vocabulary is consistent.'],
              ['Encounter ID', 'CT/01..CT/06 in lower-right monospace. Six numbered states. Every roll lands on an encounter. Optional NIST 800-61 phase mapping: Detect / Triage / Contain / Eradicate / Recover / Review.'],
              ['The roll IS the brand', 'The die tumbles every few seconds and lands on a different play. That motion — choose, commit, run — is the whole metaphor. Static at favicon size; alive at hero size.'],
            ].map(([t, body]) => (
              <div key={t}>
                <div className="mono" style={{
                  fontSize: 11, color: 'var(--signal)', letterSpacing: '0.16em',
                  textTransform: 'uppercase', marginBottom: 4,
                }}>{t}</div>
                <div className="sans" style={{
                  fontSize: 13, color: 'var(--ink-200)', lineHeight: 1.5,
                }}>{body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   04 — VARIANTS · light/dark, knockout, mono
*/
function MarkVariants() {
  const variants = [
    { label: 'PRIMARY · ON INK', bg: 'var(--ink-900)', fg: 'var(--ink-100)', accent: 'var(--signal)' },
    { label: 'INVERSE · ON PAPER', bg: 'var(--paper-050)', fg: 'var(--ink-900)', accent: 'var(--signal-deep)' },
    { label: 'KNOCKOUT · WHITE', bg: 'var(--signal-deep)', fg: 'var(--paper-050)', accent: 'var(--signal-bright)' },
    { label: 'MONO · ON INK', bg: 'var(--ink-900)', fg: 'var(--ink-100)', accent: 'var(--ink-100)' },
    { label: 'MONO · ON PAPER', bg: 'var(--paper-050)', fg: 'var(--ink-900)', accent: 'var(--ink-900)' },
    { label: 'CRITICAL', bg: 'var(--ink-900)', fg: 'var(--ink-100)', accent: 'var(--crit)' },
  ];
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">04 · mark variants</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Same mark. Six contexts.</h2>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          flex: 1,
        }}>
          {variants.map(v => (
            <div key={v.label} style={{
              background: v.bg,
              border: '1px solid var(--ink-600)',
              borderRadius: 4,
              padding: 24,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'space-between',
              gap: 16,
              minHeight: 220,
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                <Mark size={120} bg={v.bg} fg={v.fg} accent={v.accent} />
              </div>
              <div className="mono" style={{
                fontSize: 9, letterSpacing: '0.18em',
                color: v.bg === 'var(--paper-050)' ? 'var(--ink-500)' : 'var(--ink-300)',
              }}>{v.label}</div>
            </div>
          ))}
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   05 — LOCKUPS
*/
function Lockups() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">05 · lockups</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Mark + wordmark, four configurations.</h2>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1,
        }}>
          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--ink-600)',
            borderRadius: 4, padding: 32,
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 24,
          }}>
            <Caption color="var(--signal)">PRIMARY · HORIZONTAL</Caption>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Lockup name={PLACEHOLDER} size={84} brand="playbook" />
            </div>
            <Caption>Default. Use everywhere unless space forces another.</Caption>
          </div>

          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--ink-600)',
            borderRadius: 4, padding: 32,
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 24,
          }}>
            <Caption color="var(--signal)">PRIMARY · STACKED</Caption>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Lockup name={PLACEHOLDER} size={64} layout="stacked" />
            </div>
            <Caption>For square spaces — splash, social avatars, swag.</Caption>
          </div>

          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--ink-600)',
            borderRadius: 4, padding: 32,
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 24,
          }}>
            <Caption color="var(--signal)">WITH SLOGAN · HORIZONTAL</Caption>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Lockup name={PLACEHOLDER} size={72} showSlogan />
            </div>
            <Caption>Marketing surfaces, splash screen, README header.</Caption>
          </div>

          <div style={{
            background: 'var(--paper-050)', border: '1px solid var(--paper-200)',
            borderRadius: 4, padding: 32,
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 24,
          }}>
            <div className="mono" style={{
              fontSize: 11, letterSpacing: '0.24em', color: 'var(--signal-deep)',
              textTransform: 'uppercase', fontWeight: 600,
            }}>INVERSE · ON PAPER</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Lockup name={PLACEHOLDER} size={84} bg="var(--paper-050)" fg="var(--ink-900)" accent="var(--signal-deep)" />
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-500)', lineHeight: 1.4 }}>
              Print. Decks on white. Stickers.
            </div>
          </div>
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   06 — FAVICON / APP-ICON GRID
   Shows simplified mark at small sizes + full mark at large.
   Each size includes a "actual size" label so we can verify
   legibility at the size it'll actually be rendered.
*/
function FaviconGrid() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">06 · favicon · app icon</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Legible at 16. Striking at 256.</h2>
        </div>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap',
          padding: '24px 0',
        }}>
          {sizes.map(s => (
            <div key={s} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            }}>
              <div style={{ minHeight: 256, display: 'flex', alignItems: 'flex-end' }}>
                <Mark size={s} detailed={s >= 32} />
              </div>
              <Caption color="var(--ink-400)">{s}px</Caption>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: 'auto',
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
        }}>
          <div style={{
            border: '1px solid var(--ink-600)', borderRadius: 4, padding: 16,
            background: 'var(--ink-850)',
          }}>
            <Eyebrow>iOS · 180px</Eyebrow>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <Mark size={120} radius={0.232} />
            </div>
          </div>
          <div style={{
            border: '1px solid var(--ink-600)', borderRadius: 4, padding: 16,
            background: 'var(--paper-050)',
          }}>
            <div className="mono" style={{
              fontSize: 11, letterSpacing: '0.24em', color: 'var(--signal-deep)',
              textTransform: 'uppercase', fontWeight: 600,
            }}>FAVICON · LIGHT</div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <Mark size={120} bg="var(--paper-050)" fg="var(--ink-900)" accent="var(--signal-deep)" />
            </div>
          </div>
          <div style={{
            border: '1px solid var(--ink-600)', borderRadius: 4, padding: 16,
            background: 'var(--ink-900)',
          }}>
            <Eyebrow>FAVICON · DARK</Eyebrow>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <Mark size={120} />
            </div>
          </div>
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   07 — COLOR TOKENS
*/
function ColorSystem() {
  const Group = ({ title, vars }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      <div style={{ display: 'flex', gap: 4, height: 120 }}>
        {vars.map(([name, val, label]) => (
          <div key={name} style={{
            flex: 1, background: val,
            display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            padding: 8, borderRadius: 2,
            border: name.includes('paper') || name.includes('signal-100') ? '1px solid var(--ink-600)' : 'none',
          }}>
            <div className="mono" style={{
              fontSize: 9, fontWeight: 600,
              color: label === 'dark' ? 'var(--ink-900)' : 'var(--ink-100)',
              letterSpacing: '0.04em',
            }}>{name}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">07 · color</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Ink, paper, signal. Status as last resort.</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Group title="ink — operator surface" vars={[
            ['ink-950', 'var(--ink-950)', 'light'],
            ['ink-900', 'var(--ink-900)', 'light'],
            ['ink-800', 'var(--ink-800)', 'light'],
            ['ink-700', 'var(--ink-700)', 'light'],
            ['ink-600', 'var(--ink-600)', 'light'],
            ['ink-500', 'var(--ink-500)', 'light'],
            ['ink-400', 'var(--ink-400)', 'light'],
            ['ink-300', 'var(--ink-300)', 'dark'],
            ['ink-200', 'var(--ink-200)', 'dark'],
            ['ink-100', 'var(--ink-100)', 'dark'],
          ]} />
          <Group title="signal — the brand accent" vars={[
            ['signal-100',    'var(--signal-100)',    'dark'],
            ['signal-bright', 'var(--signal-bright)', 'dark'],
            ['signal',        'var(--signal)',        'dark'],
            ['signal-dim',    'var(--signal-dim)',    'light'],
            ['signal-deep',   'var(--signal-deep)',   'light'],
          ]} />
          <Group title="status — narrow on purpose" vars={[
            ['crit',  'var(--crit)',  'dark'],
            ['warn',  'var(--warn)',  'dark'],
            ['info',  'var(--info)',  'dark'],
            ['paper-050', 'var(--paper-050)', 'dark'],
            ['paper-200', 'var(--paper-200)', 'dark'],
          ]} />
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   08 — TYPE SYSTEM
*/
function TypeSystem() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">08 · type</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>JetBrains Mono drives. Inter narrates.</h2>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, flex: 1,
        }}>
          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--ink-600)',
            borderRadius: 4, padding: 28,
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div>
              <Eyebrow color="var(--signal)">primary · jetbrains mono</Eyebrow>
              <Caption color="var(--ink-400)">chrome · numbers · code · logs · timestamps</Caption>
            </div>
            <div className="mono" style={{ color: 'var(--ink-100)' }}>
              <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.01em' }}>Aa Bb 0123</div>
              <div style={{ fontSize: 13, color: 'var(--ink-300)', marginTop: 4 }}>700 · display</div>
            </div>
            <div className="mono" style={{ color: 'var(--ink-100)', fontSize: 22, fontWeight: 600 }}>
              EXERCISE START — 09:47 UTC
            </div>
            <div className="mono" style={{ color: 'var(--ink-200)', fontSize: 13, lineHeight: 1.55 }}>
              [09:31:04] ASR rule active on host<br/>
              [09:31:10] Window of unprotected execution: ~4 min<br/>
              [09:33:41] SCHEDULED TASK created: <span style={{ color: 'var(--signal)' }}>upd.exe</span>
            </div>
          </div>

          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--ink-600)',
            borderRadius: 4, padding: 28,
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div>
              <Eyebrow color="var(--signal)">secondary · inter</Eyebrow>
              <Caption color="var(--ink-400)">narrative beats · briefs · AAR body</Caption>
            </div>
            <div className="sans" style={{ color: 'var(--ink-100)' }}>
              <div style={{ fontSize: 48, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.02em' }}>Aa Bb 0123</div>
              <div className="mono" style={{ fontSize: 13, color: 'var(--ink-300)', marginTop: 4 }}>600 · display</div>
            </div>
            <div className="sans" style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink-100)', lineHeight: 1.3 }}>
              You have two parallel tracks to run.
            </div>
            <div className="sans" style={{
              fontSize: 14, color: 'var(--ink-200)', lineHeight: 1.6,
            }}>
              AMNH's web team just flagged it: the homepage has been
              replaced with a manifesto from a group calling itself the
              Heritage Reclamation Front, including a 48-hour countdown
              threatening further "revelations."
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, alignItems: 'baseline',
          padding: 16, background: 'var(--ink-800)', border: '1px solid var(--ink-600)', borderRadius: 4,
        }}>
          {[
            ['xs / 12', 12], ['sm / 13', 13], ['md / 14', 14],
            ['lg / 16', 16], ['xl / 22', 22], ['2xl / 28', 28],
          ].map(([label, size]) => (
            <div key={label}>
              <div className="mono" style={{ color: 'var(--ink-100)', fontSize: size, fontWeight: 600 }}>Aa</div>
              <Caption color="var(--ink-400)">{label}</Caption>
            </div>
          ))}
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   09 — VOICE
*/
function Voice() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">09 · voice</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Direct. Operational. No theater.</h2>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1,
        }}>
          <div style={{
            border: '1px solid var(--signal-deep)',
            background: 'color-mix(in oklch, var(--signal) 6%, transparent)',
            borderRadius: 4, padding: 24,
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div className="mono" style={{
              color: 'var(--signal)', fontSize: 12, fontWeight: 600, letterSpacing: '0.18em',
            }}>WE SAY</div>
            <Quote tone="good">"You have two parallel tracks. The clock is running. Ben — what's your immediate priority?"</Quote>
            <Quote tone="good">"Posted as a sidebar. The AI sees this on its next turn."</Quote>
            <Quote tone="good">"The AI failed to yield. Force-advance, or end the session."</Quote>
            <Quote tone="good">"Submitted as Cybersecurity Manager. Waiting on Cybersecurity Engineer."</Quote>
          </div>
          <div style={{
            border: '1px solid var(--ink-600)',
            background: 'var(--ink-850)',
            borderRadius: 4, padding: 24,
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div className="mono" style={{
              color: 'var(--crit)', fontSize: 12, fontWeight: 600, letterSpacing: '0.18em',
            }}>WE DON'T</div>
            <Quote tone="bad">"Awesome! 🎉 Let's level up your IR muscle with our gamified platform!"</Quote>
            <Quote tone="bad">"Oops — something went wrong. Please try again later."</Quote>
            <Quote tone="bad">"Whoops! Looks like the AI is taking a coffee break ☕"</Quote>
            <Quote tone="bad">"Welcome to your epic cybersecurity journey, hero!"</Quote>
          </div>
        </div>
        <div style={{
          padding: 20, background: 'var(--ink-800)', border: '1px solid var(--ink-600)',
          borderRadius: 4,
        }}>
          <Eyebrow>three rules</Eyebrow>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, marginTop: 12,
          }}>
            {[
              ['Name the actor.', '"The AI failed to yield" — not "something went wrong."'],
              ['Name the next action.', '"Force-advance, or end the session" — give the operator a verb.'],
              ['No exclamation points.', 'Ever. The product is used in real incidents and rehearsals for them.'],
            ].map(([t, body]) => (
              <div key={t}>
                <div className="mono" style={{
                  color: 'var(--signal)', fontSize: 12, fontWeight: 600,
                  letterSpacing: '0.08em', marginBottom: 6,
                }}>{t}</div>
                <div className="sans" style={{ fontSize: 13, color: 'var(--ink-200)', lineHeight: 1.5 }}>{body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ArtboardSurface>
  );
}

function Quote({ children, tone }) {
  const color = tone === 'good' ? 'var(--ink-100)' : 'var(--ink-300)';
  const border = tone === 'good' ? 'var(--signal)' : 'var(--ink-500)';
  return (
    <div style={{
      borderLeft: `3px solid ${border}`,
      paddingLeft: 14,
      fontFamily: tone === 'good' ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
      fontSize: 14, color, lineHeight: 1.45,
      textDecoration: tone === 'bad' ? 'line-through' : 'none',
      textDecorationColor: 'var(--crit)',
      textDecorationThickness: '1px',
    }}>{children}</div>
  );
}

/* ============================================================
   10 — STICKERS / SOCIAL
*/
function Stickers() {
  return (
    <ArtboardSurface bg="var(--ink-950)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">10 · stickers · social</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>For laptops. For posts. For the team channel.</h2>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, flex: 1,
        }}>
          {/* 1 — main lockup sticker */}
          <Sticker bg="var(--ink-900)" border="var(--ink-500)">
            <Lockup name={PLACEHOLDER} size={48} layout="stacked" showSlogan />
          </Sticker>
          {/* 2 — slogan-only */}
          <Sticker bg="var(--signal)" border="var(--signal-deep)">
            <div className="mono" style={{
              color: 'var(--ink-900)', fontSize: 18, fontWeight: 700,
              textAlign: 'center', lineHeight: 1.2, letterSpacing: '0.04em',
            }}>
              ROLL.<br/>RESPOND.<br/>REVIEW.
            </div>
          </Sticker>
          {/* 3 — exercise complete */}
          <Sticker bg="var(--ink-900)" border="var(--signal-deep)">
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--signal)', letterSpacing: '0.24em' }}>EXERCISE COMPLETE</div>
              <Mark size={56} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-200)', fontWeight: 600 }}>14 turns · 0 stuck</div>
            </div>
          </Sticker>
          {/* 4 — paper variant */}
          <Sticker bg="var(--paper-050)" border="var(--paper-200)">
            <Lockup name={PLACEHOLDER} size={48} layout="stacked"
              bg="var(--paper-050)" fg="var(--ink-900)" accent="var(--signal-deep)" />
          </Sticker>

          {/* 5 — terminal-style */}
          <Sticker bg="var(--ink-950)" border="var(--ink-600)" wide>
            <div className="mono" style={{
              color: 'var(--signal)', fontSize: 13, lineHeight: 1.5, fontWeight: 500,
            }}>
              <div style={{ color: 'var(--ink-300)' }}>$ {PLACEHOLDER.toLowerCase()} run --scenario ransomware</div>
              <div>→ session created · 3 roles invited</div>
              <div>→ AI drafting plan<span className="blink" style={{ color: 'var(--signal)' }}>_</span></div>
            </div>
          </Sticker>
          {/* 6 — incident commander badge */}
          <Sticker bg="var(--crit)" border="var(--crit)">
            <div className="mono" style={{
              color: 'var(--ink-050)', fontSize: 12, fontWeight: 700,
              textAlign: 'center', lineHeight: 1.3, letterSpacing: '0.12em',
            }}>
              <div style={{ fontSize: 10, opacity: 0.7 }}>CERTIFIED</div>
              <div style={{ fontSize: 18 }}>INCIDENT</div>
              <div style={{ fontSize: 18 }}>COMMANDER</div>
            </div>
          </Sticker>
          {/* 7 — die only */}
          <Sticker bg="var(--ink-900)" border="var(--ink-600)">
            <Mark size={84} blink roll rollPeriod={4500} />
          </Sticker>
        </div>
      </div>
    </ArtboardSurface>
  );
}

function Sticker({ children, bg, border, wide }) {
  return (
    <div style={{
      background: bg, border: `1px dashed ${border}`,
      borderRadius: 12,
      padding: 20,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: 160,
      gridColumn: wide ? 'span 2' : 'span 1',
    }}>{children}</div>
  );
}

/* ============================================================
   02b — BRAND EXPLORATION (3 pip metaphors)
*/
function BrandExploration() {
  // 6 war-room variants. All share vocabulary: rounded-rect (or circle/blob)
  // table outline, circular Os for seats (people), small d6-pip in the center
  // (the "thing on the table"), one seat cycling through signal-blue. Geometric-clean,
  // no hand-drawing, no blindspot. The cycle animation is the brand's signature motion.
  const options = [
    {
      brand: 'table-square',
      name: 'SQUARE',
      tagline: '8 around · die-rhyme',
      body: 'Square table, 8 seats — closest to the d6\'s symmetry. Strongest morph candidate. The default.',
    },
    {
      brand: 'table-round',
      name: 'ROUND',
      tagline: '6 evenly spaced',
      body: 'Round table, 6 seats. Collaborative. Reads as discussion-not-hierarchy. Less mechanical than the square.',
    },
    {
      brand: 'table-long',
      name: 'LONG',
      tagline: 'long edges + head',
      body: 'Long rectangular table with seats clustered along the long edges. Conference-room familiar.',
    },
    {
      brand: 'table-boardroom',
      name: 'BOARDROOM',
      tagline: '4 + 4 facing',
      body: 'Long table, no head. Two equal sides. Reads as "two camps in dialogue" — Red vs. Blue, IT vs. business.',
    },
    {
      brand: 'table-sparse',
      name: 'SPARSE',
      tagline: '1 per side · breathing room',
      body: 'Just 4 seats — minimum readable "table." Quietest. Best at small scale. Loses the cycle\'s rhythm.',
    },
    {
      brand: 'table-asym',
      name: 'CLUSTER',
      tagline: 'curved · in-conversation',
      body: 'Curved/blob table, 5 asymmetric seats. Looks like a real room, not a diagram. Hardest to render small.',
    },
  ];
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">02b · war room · variations</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>Six war-rooms. Pick the geometry.</h2>
          <p className="sans" style={{
            fontSize: 14, color: 'var(--ink-200)', margin: '12px 0 0', maxWidth: 760, lineHeight: 1.5,
          }}>
            All share the vocabulary: rounded table, circular Os for people, a tiny d6-pip in the center
            (the thing on the table — ties back to the dice). One seat cycles through signal-blue —
            <em style={{ color: 'var(--ink-050)', fontStyle: 'normal' }}> whose turn</em>. That cycle <em style={{ color: 'var(--ink-050)', fontStyle: 'normal' }}>is</em> the brand's signature motion.
            Blue Team blue, because tabletop is a Blue Team discipline.
          </p>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(2, 1fr)', gap: 14, flex: 1,
        }}>
          {options.map(opt => (
            <div key={opt.brand} style={{
              background: 'var(--ink-850)',
              border: '1px solid var(--ink-600)',
              borderRadius: 4,
              padding: 18,
              display: 'flex', flexDirection: 'column', gap: 12,
              position: 'relative',
            }}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
                <Mark size={120} brand={opt.brand} blink={true} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 14, alignItems: 'flex-end' }}>
                <Mark size={36} brand={opt.brand} blink={false} />
                <Mark size={24} brand={opt.brand} blink={false} />
                <Mark size={16} brand={opt.brand} blink={false} detailed={false} />
              </div>
              <div style={{ borderTop: '1px solid var(--ink-600)', paddingTop: 10 }}>
                <div className="mono" style={{
                  fontSize: 14, color: 'var(--ink-050)', fontWeight: 700, letterSpacing: '0.16em',
                }}>{opt.name}</div>
                <div className="mono" style={{
                  fontSize: 10, color: 'var(--signal)', letterSpacing: '0.14em',
                  textTransform: 'uppercase', marginTop: 4,
                }}>{opt.tagline}</div>
              </div>
              <div className="sans" style={{ fontSize: 12, color: 'var(--ink-200)', lineHeight: 1.45 }}>
                {opt.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   02c — MORPH SHOWCASE (die ↔ table animation)
*/
function MorphShowcase() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">02c · the morph</Eyebrow>
          <h2 className="mono" style={{
            fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0',
          }}>The die <em style={{ color: 'var(--signal)', fontStyle: 'normal' }}>is</em> the tabletop.</h2>
          <p className="sans" style={{
            fontSize: 14, color: 'var(--ink-200)', margin: '12px 0 0', maxWidth: 720, lineHeight: 1.5,
          }}>
            Four corner pips hold their position. The center pip cross-fades to a small open square
            and a table outline gently breathes in around them — the d6 settles into a war-room
            seen from above. No motion, no rotation, no spinning seats. Just opacity. Use it on
            the loading splash, the empty-state hero, and the README header.
          </p>
        </div>

        {/* Big hero loop */}
        <div style={{
          flex: 1,
          display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24,
        }}>
          <div style={{
            background: 'var(--ink-850)',
            border: '1px solid var(--ink-600)',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <Mark size={420} brand="morph" blink={false} />
            <div className="mono" style={{
              position: 'absolute', bottom: 14, left: 14,
              fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.18em',
            }}>HERO LOOP · 8s · ease-in-out</div>
          </div>

          {/* Stop frames showing the cycle */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { brand: 'playbook', label: 'DIE · 4-face', sub: 'corners hold · center is a pip' , override: 'die' },
              { brand: 'morph',    label: 'MORPH · slow', sub: 'opacity only · ~3s breath', override: 'morph' },
              { brand: 'table',    label: 'TABLE · top-down', sub: 'corners are seats · pip is empty', override: 'table' },
            ].map((s, i) => (
              <div key={i} style={{
                flex: 1,
                background: 'var(--ink-850)',
                border: '1px solid var(--ink-600)',
                borderRadius: 4,
                padding: 14,
                display: 'grid', gridTemplateColumns: '88px 1fr', gap: 16, alignItems: 'center',
              }}>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  {s.override === 'die' ? <DiePure size={72} /> : <Mark size={72} brand={s.brand} blink={false} />}
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--signal)', letterSpacing: '0.16em' }}>
                    {s.label}
                  </div>
                  <div className="sans" style={{ fontSize: 12, color: 'var(--ink-300)', marginTop: 4 }}>
                    {s.sub}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mono" style={{
          fontSize: 11, color: 'var(--ink-400)', letterSpacing: '0.16em',
          borderTop: '1px solid var(--ink-700)', paddingTop: 14,
        }}>
          // motion is a signature, not decoration. Use only at brand surfaces (splash, hero, README); never in chrome.
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* ============================================================
   02d — PLAYBOOK LIBRARY
   The 6 plays the die rolls between, shown statically so the
   geometry of each is legible.
*/
function PlaybookLibrary() {
  return (
    <ArtboardSurface>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
        <div>
          <Eyebrow color="var(--signal)">02d · the playbook</Eyebrow>
          <h2 className="mono" style={{ fontSize: 28, color: 'var(--ink-050)', fontWeight: 700, margin: '8px 0 0' }}>
            Six plays. The die rolls between them.
          </h2>
          <p className="sans" style={{ fontSize: 14, color: 'var(--ink-200)', margin: '12px 0 0', maxWidth: 780, lineHeight: 1.5 }}>
            Every play uses the same vocabulary — five Os on a line, one X for the runner,
            curved bezier routes with chevron heads. Different arrangements, same alphabet.
            The mark animation tumbles the die through these six on the cover, the loading
            splash, the README header. In product chrome, it sits still on CT/01.
          </p>
        </div>
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gridTemplateRows: 'repeat(2, 1fr)',
          gap: 20,
        }}>
          {(window.PLAYS || []).map((play, i) => (
            <div key={i} style={{
              background: 'var(--ink-850)',
              border: '1px solid var(--ink-600)',
              borderRadius: 4,
              padding: 20,
              display: 'flex', flexDirection: 'column', gap: 12,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Mark size={180} brand="playbook" blink={false} playIndex={i} />
              <div className="mono" style={{
                fontSize: 11, color: 'var(--signal)', letterSpacing: '0.16em',
                marginTop: 4,
              }}>
                {play.id} · {['canonical', 'slant left', 'option right', 'power up middle', 'wide sweep', 'counter'][i]}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ArtboardSurface>
  );
}

/* tiny helper — pure 4-face die (matches the morph geometry) */
function DiePure({ size = 72 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <rect x="6" y="6" width="88" height="88" rx="14" fill="var(--ink-900)" stroke="var(--ink-050)" strokeWidth="3" />
      <circle cx="30" cy="30" r="4.6" fill="var(--ink-050)" />
      <circle cx="70" cy="30" r="4.6" fill="var(--signal)" />
      <circle cx="30" cy="70" r="4.6" fill="var(--ink-050)" />
      <circle cx="70" cy="70" r="4.6" fill="var(--ink-050)" />
      {/* center pip — matches the morph's static center in the die phase */}
      <circle cx="50" cy="50" r="4.6" fill="var(--ink-050)" />
    </svg>
  );
}

Object.assign(window, {
  BrandCover, NamingNote, MarkConstruction, MarkVariants, Lockups,
  FaviconGrid, ColorSystem, TypeSystem, Voice, Stickers, BrandExploration,
  MorphShowcase, PlaybookLibrary,
  PLACEHOLDER, SLOGAN,
});
