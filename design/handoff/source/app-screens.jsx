/* ============================================================
   APP SCREENS — hi-fi mocks for Claude Code handoff
   ============================================================
   Tactical HUD aesthetic: chat as the focal panel, rails on left
   (roles, turn state) and right (timeline, inject feed, gauges).
   Top status strip + bottom action bar.

   These are designed at 1440x900 unless noted, fixed-frame so
   the engineer can match pixel positions when implementing.
   ============================================================ */

const PRESS_GAUGE_VALUE = 0.62; // 0..1, demo

function StatusChip({ label, value, tone = 'default', mono = true }) {
  const tones = {
    default: { bg: 'var(--ink-700)', fg: 'var(--ink-100)', border: 'var(--ink-500)' },
    signal:  { bg: 'color-mix(in oklch, var(--signal) 14%, transparent)', fg: 'var(--signal)', border: 'var(--signal-deep)' },
    crit:    { bg: 'var(--crit-bg)',  fg: 'var(--crit)',   border: 'var(--crit)' },
    warn:    { bg: 'var(--warn-bg)',  fg: 'var(--warn)',   border: 'var(--warn)' },
    info:    { bg: 'var(--info-bg)',  fg: 'var(--info)',   border: 'var(--info)' },
  };
  const t = tones[tone];
  return (
    <div className={mono ? 'mono' : 'sans'} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 8px', borderRadius: 2,
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function PressureGauge({ value = 0.5, label = 'MGMT PRESSURE' }) {
  const pct = Math.round(value * 100);
  const tone = value > 0.75 ? 'crit' : value > 0.5 ? 'warn' : 'signal';
  const color = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : 'var(--signal)';
  // 60-tick gauge
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="mono" style={{
          fontSize: 10, color: 'var(--ink-300)', letterSpacing: '0.18em', fontWeight: 600,
        }}>{label}</div>
        <div className="mono" style={{
          fontSize: 13, color, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        }}>{pct}%</div>
      </div>
      <div style={{ display: 'flex', gap: 2, height: 14 }}>
        {Array.from({ length: 30 }).map((_, i) => {
          const active = (i / 30) < value;
          const c = active
            ? (i / 30 > 0.8 ? 'var(--crit)' : i / 30 > 0.55 ? 'var(--warn)' : 'var(--signal)')
            : 'var(--ink-700)';
          return <div key={i} style={{ flex: 1, background: c, borderRadius: 1 }} />;
        })}
      </div>
    </div>
  );
}

/* ============================================================
   APP CHROME — top bar shared by all screens
*/
function AppTopBar({ session = 'PROMETHEUS-09', state = 'AWAITING_PLAYERS', turn = 7, elapsed = '00:42:18' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '12px 20px',
      background: 'var(--ink-850)',
      borderBottom: '1px solid var(--ink-600)',
      height: 56, boxSizing: 'border-box',
    }}>
      <Lockup name={PLACEHOLDER} size={28} brand="playbook" />
      <div style={{ width: 1, height: 24, background: 'var(--ink-600)' }} />
      <div className="mono" style={{ fontSize: 12, color: 'var(--ink-300)' }}>
        SESSION <span style={{ color: 'var(--ink-100)', fontWeight: 600 }}>{session}</span>
      </div>
      <StatusChip label="STATE" value={state} tone={state === 'AWAITING_PLAYERS' ? 'warn' : 'signal'} />
      <StatusChip label="TURN" value={turn} />
      <StatusChip label="ELAPSED" value={elapsed} />
      <div style={{ flex: 1 }} />
      <StatusChip label="● LIVE" value="3 / 4" tone="signal" />
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'var(--ink-700)', border: '1px solid var(--ink-500)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--ink-100)', fontSize: 11, fontWeight: 700,
      }} className="mono">RB</div>
    </div>
  );
}

/* ============================================================
   01 — TACTICAL HUD (in-session, awaiting players)
*/
function AppTacticalHUD() {
  return (
    <div style={{
      width: '100%', height: '100%',
      background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <AppTopBar />
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: '240px 1fr 320px',
        gap: 0, minHeight: 0,
      }}>
        {/* LEFT RAIL — roles + turn state */}
        <LeftRail />
        {/* CENTER — chat */}
        <CenterChat />
        {/* RIGHT RAIL — timeline + injects + gauges */}
        <RightRail />
      </div>
      {/* bottom action bar */}
      <ActionBar />
    </div>
  );
}

function LeftRail() {
  const roles = [
    { code: 'IC',  name: 'Incident Commander',     player: 'R. Briggs',   state: 'submitted', you: true },
    { code: 'CSM', name: 'Cybersecurity Manager',  player: 'A. Park',     state: 'submitted', you: false },
    { code: 'CSE', name: 'Cybersecurity Engineer', player: 'D. Okafor',   state: 'pending',   you: false },
    { code: 'COM', name: 'Comms / Legal',          player: 'M. Hanover',  state: 'idle',      you: false, inactive: true },
  ];
  return (
    <div style={{
      borderRight: '1px solid var(--ink-600)',
      background: 'var(--ink-850)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <RailHeader title="ROLES" subtitle="3 active · 1 standby" />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {roles.map(r => (
          <RoleCard key={r.code} role={r} />
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--ink-600)', padding: 12, marginTop: 8 }}>
        <RailHeader title="TURN STATE" subtitle="awaiting 1 of 3" inline />
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <TurnState step="setup" done />
          <TurnState step="briefing" done />
          <TurnState step="ai_processing" done />
          <TurnState step="awaiting_players" active />
          <TurnState step="ai_processing" pending />
          <TurnState step="ended" pending />
        </div>
      </div>
    </div>
  );
}

function RailHeader({ title, subtitle, inline }) {
  return (
    <div style={{
      padding: inline ? '0 0 4px' : '14px 16px 10px',
      borderBottom: inline ? 'none' : '1px solid var(--ink-600)',
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    }}>
      <div className="mono" style={{
        fontSize: 10, fontWeight: 700, color: 'var(--ink-200)',
        letterSpacing: '0.22em',
      }}>{title}</div>
      {subtitle && (
        <div className="mono" style={{
          fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.04em',
        }}>{subtitle}</div>
      )}
    </div>
  );
}

function RoleCard({ role }) {
  const stateColor = role.state === 'submitted' ? 'var(--signal)'
                   : role.state === 'pending'   ? 'var(--warn)'
                   : 'var(--ink-500)';
  const stateLabel = role.state === 'submitted' ? '✓ SUBMITTED'
                   : role.state === 'pending'   ? '◐ TYPING'
                   : '○ IDLE';
  return (
    <div style={{
      padding: 10,
      background: role.you ? 'color-mix(in oklch, var(--signal) 8%, var(--ink-800))' : 'var(--ink-800)',
      border: `1px solid ${role.you ? 'var(--signal-deep)' : 'var(--ink-600)'}`,
      borderRadius: 3,
      display: 'flex', flexDirection: 'column', gap: 6,
      opacity: role.inactive ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="mono" style={{
          fontSize: 11, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.08em',
        }}>{role.code}{role.you && <span style={{ color: 'var(--signal)', marginLeft: 6 }}>· YOU</span>}</div>
        <div className="mono" style={{
          fontSize: 9, color: stateColor, letterSpacing: '0.08em', fontWeight: 600,
        }}>{stateLabel}</div>
      </div>
      <div className="sans" style={{ fontSize: 11, color: 'var(--ink-200)', lineHeight: 1.3 }}>
        {role.name}
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>
        {role.player}
      </div>
    </div>
  );
}

function TurnState({ step, done, active, pending }) {
  const labels = {
    setup: 'SETUP',
    briefing: 'BRIEFING',
    ai_processing: 'AI PROCESSING',
    awaiting_players: 'AWAITING PLAYERS',
    ended: 'ENDED',
  };
  const color = done    ? 'var(--ink-400)'
              : active  ? 'var(--signal)'
              :           'var(--ink-500)';
  const dot = done ? '●' : active ? '◉' : '○';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="mono" style={{ fontSize: 12, color, width: 14 }}>{dot}</span>
      <span className="mono" style={{
        fontSize: 10, color, letterSpacing: '0.12em', fontWeight: active ? 700 : 500,
      }}>{labels[step]}</span>
      {active && (
        <div style={{ flex: 1, height: 2, background: 'var(--ink-700)', borderRadius: 1, overflow: 'hidden' }}>
          <div style={{
            width: '60%', height: '100%', background: 'var(--signal)',
            animation: 'tt-pulse 1.6s ease-in-out infinite',
          }} />
        </div>
      )}
    </div>
  );
}

function CenterChat() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--ink-900)',
      minHeight: 0,
    }}>
      {/* scenario bar */}
      <div style={{
        padding: '14px 24px',
        borderBottom: '1px solid var(--ink-600)',
        background: 'var(--ink-850)',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <div>
          <div className="mono" style={{
            fontSize: 10, color: 'var(--signal)', letterSpacing: '0.22em', fontWeight: 700,
          }}>SCENARIO · DEFACEMENT + EXFIL</div>
          <div className="sans" style={{
            fontSize: 14, color: 'var(--ink-100)', fontWeight: 600, marginTop: 2,
          }}>AMNH homepage replaced · 48hr countdown · suspected DB leak</div>
        </div>
        <div style={{ flex: 1 }} />
        <StatusChip label="SEV" value="HIGH" tone="crit" />
        <StatusChip label="AI" value="haiku-4.5" tone="info" />
      </div>

      {/* chat scroll area */}
      <div style={{
        flex: 1, overflow: 'hidden',
        padding: '20px 24px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <SystemBeat>
          T+00:42:18 · TURN 7 INITIATED · AI ROUTED TO <span style={{ color: 'var(--signal)' }}>CSE, CSM</span>
        </SystemBeat>

        <AIBubble role="FACILITATOR" turn={7}>
          <p style={{ margin: 0 }}>
            You have two parallel tracks to run.
          </p>
          <p style={{ margin: '8px 0 0' }}>
            <strong style={{ color: 'var(--ink-050)' }}>Track A — containment.</strong> The web team confirms the manifesto
            replaced index.html at 09:31 UTC. ASR rule was active on the host; window of unprotected
            execution was ~4 minutes. A scheduled task <span className="mono" style={{ color: 'var(--signal)' }}>upd.exe</span> was
            registered at 09:33:41.
          </p>
          <p style={{ margin: '8px 0 0' }}>
            <strong style={{ color: 'var(--ink-050)' }}>Track B — verification.</strong> The Heritage Reclamation Front
            claims to have donor records for ~280K supporters. They've posted three sample rows.
            Marketing is asking whether to acknowledge the breach in tomorrow's newsletter.
          </p>
          <div style={{
            marginTop: 14, padding: '10px 12px',
            background: 'var(--ink-800)', borderLeft: '2px solid var(--signal)', borderRadius: 2,
          }}>
            <div className="mono" style={{
              fontSize: 10, color: 'var(--signal)', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 4,
            }}>NEXT ACTION</div>
            <div className="sans" style={{ fontSize: 13, color: 'var(--ink-100)' }}>
              <strong>CSE</strong>: triage upd.exe and the 09:31 window. <strong>CSM</strong>: decide on the donor-record claim — verify, escalate, or hold.
            </div>
          </div>
        </AIBubble>

        <PlayerBubble role="CSM" name="A. Park" submitted>
          Holding on the donor-record claim. The three sample rows look like they could be from the
          2019 spreadsheet that was discoverable for ~3 weeks before we plugged it. Pulling that
          archive now to compare schemas. Will not acknowledge in tomorrow's newsletter — that's a
          legal-and-comms call I want to escalate cleanly, not pre-empt.
        </PlayerBubble>

        <PlayerBubble role="IC" name="R. Briggs" you submitted>
          Concur on holding the newsletter. Looping legal in via sidebar, not in chat. CSE — when
          you've got upd.exe behavior, drop it as an artifact, don't summarize.
        </PlayerBubble>

        <TypingBubble role="CSE" name="D. Okafor" />
      </div>

      {/* composer */}
      <Composer />
    </div>
  );
}

function SystemBeat({ children }) {
  return (
    <div className="mono" style={{
      fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.16em',
      textAlign: 'center', padding: '4px 0',
      borderTop: '1px dashed var(--ink-600)', borderBottom: '1px dashed var(--ink-600)',
      fontWeight: 600,
    }}>{children}</div>
  );
}

function AIBubble({ role, turn, children }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{
        width: 36, height: 36, borderRadius: 4, flexShrink: 0,
        background: 'var(--ink-800)', border: '1px solid var(--signal-deep)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Mark size={26} brand="playbook" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span className="mono" style={{
            fontSize: 11, fontWeight: 700, color: 'var(--signal)', letterSpacing: '0.14em',
          }}>{role}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>TURN {turn}</span>
        </div>
        <div className="sans" style={{
          background: 'var(--ink-800)',
          border: '1px solid var(--ink-600)',
          borderLeft: '2px solid var(--signal)',
          padding: '14px 16px', borderRadius: 3,
          fontSize: 13, color: 'var(--ink-100)', lineHeight: 1.55,
        }}>{children}</div>
      </div>
    </div>
  );
}

function PlayerBubble({ role, name, you, submitted, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, paddingLeft: 24 }}>
      <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, justifyContent: 'flex-end' }}>
          {submitted && (
            <span className="mono" style={{ fontSize: 9, color: 'var(--signal)', letterSpacing: '0.16em', fontWeight: 700 }}>✓ SUBMITTED</span>
          )}
          <span className="mono" style={{
            fontSize: 11, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em',
          }}>{role}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>{name}{you && ' · YOU'}</span>
        </div>
        <div className="sans" style={{
          background: you ? 'color-mix(in oklch, var(--signal) 10%, var(--ink-800))' : 'var(--ink-800)',
          border: `1px solid ${you ? 'var(--signal-deep)' : 'var(--ink-600)'}`,
          padding: '12px 14px', borderRadius: 3,
          fontSize: 13, color: 'var(--ink-100)', lineHeight: 1.55,
          textAlign: 'left',
        }}>{children}</div>
      </div>
      <div style={{
        width: 36, height: 36, borderRadius: 4, flexShrink: 0,
        background: 'var(--ink-700)', border: '1px solid var(--ink-500)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--ink-100)', fontWeight: 700, fontSize: 11,
      }} className="mono">{role}</div>
    </div>
  );
}

function TypingBubble({ role, name }) {
  return (
    <div style={{ display: 'flex', gap: 12, paddingLeft: 24, opacity: 0.85 }}>
      <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, justifyContent: 'flex-end' }}>
          <span className="mono" style={{ fontSize: 9, color: 'var(--warn)', letterSpacing: '0.16em', fontWeight: 700 }}>◐ TYPING</span>
          <span className="mono" style={{
            fontSize: 11, fontWeight: 700, color: 'var(--ink-200)', letterSpacing: '0.10em',
          }}>{role}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>{name}</span>
        </div>
        <div style={{
          background: 'var(--ink-800)', border: '1px dashed var(--ink-500)',
          padding: '14px 16px', borderRadius: 3,
          display: 'inline-flex', gap: 4,
        }}>
          <Dot delay={0} /><Dot delay={150} /><Dot delay={300} />
        </div>
      </div>
      <div style={{
        width: 36, height: 36, borderRadius: 4, flexShrink: 0,
        background: 'var(--ink-700)', border: '1px dashed var(--ink-500)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--ink-300)', fontWeight: 700, fontSize: 11,
      }} className="mono">{role}</div>
    </div>
  );
}

function Dot({ delay }) {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-300)',
      animation: 'tt-blink 1.2s ease-in-out infinite', animationDelay: `${delay}ms`,
    }} />
  );
}

function Composer() {
  return (
    <div style={{
      borderTop: '1px solid var(--ink-600)',
      background: 'var(--ink-850)',
      padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{
          fontSize: 10, color: 'var(--signal)', letterSpacing: '0.18em', fontWeight: 700,
        }}>RESPONDING AS · IC</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>
          / commands · ? mid-turn question · @ mention role
        </span>
      </div>
      <div style={{
        background: 'var(--ink-900)', border: '1px solid var(--signal-deep)',
        borderRadius: 3, padding: '14px 16px',
        minHeight: 88, color: 'var(--ink-100)', fontSize: 14,
        fontFamily: "'Inter', system-ui, sans-serif", lineHeight: 1.5,
      }}>
        Holding the newsletter. CSE — when you have upd.exe behavior, post it as an artifact, not a summary.<span className="blink" style={{ color: 'var(--signal)', fontWeight: 700 }}>▍</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <ComposerBtn>+ ARTIFACT</ComposerBtn>
        <ComposerBtn>?  QUESTION</ComposerBtn>
        <ComposerBtn>@  MENTION</ComposerBtn>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>⌘+ENTER to submit</span>
        <button className="mono" style={{
          background: 'var(--signal)', color: 'var(--ink-900)',
          border: 'none', padding: '8px 16px', borderRadius: 2,
          fontWeight: 700, fontSize: 11, letterSpacing: '0.16em', cursor: 'pointer',
        }}>SUBMIT RESPONSE →</button>
      </div>
    </div>
  );
}

function ComposerBtn({ children }) {
  return (
    <button className="mono" style={{
      background: 'transparent', color: 'var(--ink-200)',
      border: '1px solid var(--ink-500)', padding: '6px 10px', borderRadius: 2,
      fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', cursor: 'pointer',
    }}>{children}</button>
  );
}

function RightRail() {
  return (
    <div style={{
      borderLeft: '1px solid var(--ink-600)',
      background: 'var(--ink-850)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <RailHeader title="HUD" subtitle="live" />
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14, borderBottom: '1px solid var(--ink-600)' }}>
        <PressureGauge value={PRESS_GAUGE_VALUE} label="MGMT PRESSURE" />
        <PressureGauge value={0.34} label="CONTAINMENT" />
        <PressureGauge value={0.18} label="BURN RATE" />
      </div>

      <RailHeader title="INJECT FEED" subtitle="3 queued" />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Inject t="T+00:42" tone="warn" title="MARKETING ASKING ABOUT NEWSLETTER" body="VP Marketing wants to know if tomorrow's newsletter should mention the incident." />
        <Inject t="T+00:38" tone="crit" title="HRF POSTED 3 SAMPLE ROWS" body="On their leak site. PII fields visible. 280K total claimed." />
        <Inject t="T+00:31" tone="info" title="ASR RULE ACTIVE — HOST" body="Window of unprotected execution: ~4 min. Scheduled task created: upd.exe" />
      </div>

      <div style={{ borderTop: '1px solid var(--ink-600)', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <RailHeader title="TIMELINE" subtitle="14 events" />
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, flex: 1, overflow: 'hidden' }}>
          {[
            ['T+00:42', 'CSM holds on donor-record claim', 'submitted'],
            ['T+00:42', 'IC concurs · escalating legal', 'submitted'],
            ['T+00:41', 'AI yielded to CSE, CSM', 'ai'],
            ['T+00:38', 'HRF leak-site post', 'inject'],
            ['T+00:33', 'upd.exe scheduled task', 'evidence'],
            ['T+00:31', 'Defacement begins', 'evidence'],
          ].map((row, i) => (
            <TimelineRow key={i} time={row[0]} body={row[1]} kind={row[2]} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Inject({ t, tone, title, body }) {
  const color = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : 'var(--info)';
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--ink-800)',
      borderLeft: `3px solid ${color}`,
      borderRadius: '0 3px 3px 0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <div className="mono" style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: '0.18em' }}>{title}</div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--ink-400)' }}>{t}</div>
      </div>
      <div className="sans" style={{ fontSize: 11, color: 'var(--ink-200)', lineHeight: 1.4 }}>{body}</div>
    </div>
  );
}

function TimelineRow({ time, body, kind }) {
  const dotColor = kind === 'submitted' ? 'var(--signal)'
                 : kind === 'ai'        ? 'var(--info)'
                 : kind === 'inject'    ? 'var(--warn)'
                 :                        'var(--ink-300)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span className="mono" style={{ fontSize: 9, color: 'var(--ink-400)', width: 44, marginTop: 2 }}>{time}</span>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: dotColor,
        marginTop: 6, flexShrink: 0,
      }} />
      <span className="sans" style={{ fontSize: 11, color: 'var(--ink-200)', lineHeight: 1.4 }}>{body}</span>
    </div>
  );
}

function ActionBar() {
  return (
    <div style={{
      borderTop: '1px solid var(--ink-600)',
      background: 'var(--ink-950)',
      padding: '10px 20px',
      display: 'flex', alignItems: 'center', gap: 12,
      height: 48, boxSizing: 'border-box',
    }}>
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.18em' }}>CREATOR ADMIN</span>
      <AdminBtn>FORCE-ADVANCE</AdminBtn>
      <AdminBtn>INTERJECT</AdminBtn>
      <AdminBtn>PROXY-RESPOND</AdminBtn>
      <AdminBtn tone="crit">END SESSION</AdminBtn>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>WS · live</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--signal)', fontWeight: 700, letterSpacing: '0.18em' }}>● CONNECTED</span>
    </div>
  );
}

function AdminBtn({ children, tone }) {
  const color = tone === 'crit' ? 'var(--crit)' : 'var(--ink-200)';
  const border = tone === 'crit' ? 'var(--crit)' : 'var(--ink-500)';
  return (
    <button className="mono" style={{
      background: 'transparent', color, border: `1px solid ${border}`,
      padding: '6px 12px', borderRadius: 2,
      fontSize: 10, fontWeight: 600, letterSpacing: '0.16em', cursor: 'pointer',
    }}>{children}</button>
  );
}

/* ============================================================
   02 — CREATOR · NEW SESSION SETUP WIZARD
*/
function AppCreatorSetup() {
  return (
    <div style={{
      width: '100%', height: '100%',
      background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <AppTopBar session="DRAFT-04" state="SETUP" turn={0} elapsed="—" />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '260px 1fr', minHeight: 0 }}>
        {/* steps rail */}
        <div style={{
          background: 'var(--ink-850)', borderRight: '1px solid var(--ink-600)', padding: 16,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <RailHeader title="SETUP" subtitle="3 of 6" />
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SetupStep n="01" name="Scenario" done />
            <SetupStep n="02" name="Environment" done />
            <SetupStep n="03" name="Roles" active />
            <SetupStep n="04" name="Injects & schedule" />
            <SetupStep n="05" name="Invite players" />
            <SetupStep n="06" name="Review & launch" />
          </div>
        </div>
        {/* main */}
        <div style={{ padding: 36, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <Eyebrow color="var(--signal)">step 03 · roles</Eyebrow>
            <h1 className="sans" style={{
              fontSize: 32, fontWeight: 600, color: 'var(--ink-050)',
              margin: '8px 0 0', letterSpacing: '-0.02em',
            }}>Who's in the room?</h1>
            <p className="sans" style={{
              fontSize: 14, color: 'var(--ink-300)', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5,
            }}>
              Each role is a seat at the table. The AI facilitator routes turns to active roles only —
              standby roles can be activated mid-session if a thread requires them.
            </p>
          </div>

          <div style={{
            border: '1px solid var(--ink-600)', borderRadius: 4,
            background: 'var(--ink-850)',
          }}>
            {[
              { code: 'IC', name: 'Incident Commander', desc: 'Owns the response. Final call on tradeoffs.', active: true },
              { code: 'CSM', name: 'Cybersecurity Manager', desc: 'Coordinates engineering effort. Reports up.', active: true },
              { code: 'CSE', name: 'Cybersecurity Engineer', desc: 'Hands-on triage and containment.', active: true },
              { code: 'COM', name: 'Comms / Legal', desc: 'External voice. Press, regulators, customers.', standby: true },
              { code: 'EXE', name: 'Executive Sponsor', desc: 'C-suite. Activate when stakes escalate.', standby: true },
            ].map((r, i, arr) => (
              <RoleSetupRow key={r.code} role={r} last={i === arr.length - 1} />
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
            <button className="mono" style={{
              background: 'transparent', color: 'var(--ink-300)',
              border: '1px solid var(--ink-500)', padding: '10px 18px', borderRadius: 2,
              fontSize: 11, fontWeight: 600, letterSpacing: '0.18em', cursor: 'pointer',
            }}>← BACK · ENVIRONMENT</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="mono" style={{
                background: 'transparent', color: 'var(--ink-200)',
                border: '1px solid var(--ink-500)', padding: '10px 18px', borderRadius: 2,
                fontSize: 11, fontWeight: 600, letterSpacing: '0.18em', cursor: 'pointer',
              }}>SAVE DRAFT</button>
              <button className="mono" style={{
                background: 'var(--signal)', color: 'var(--ink-900)',
                border: 'none', padding: '10px 22px', borderRadius: 2,
                fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', cursor: 'pointer',
              }}>NEXT · INJECTS →</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SetupStep({ n, name, done, active }) {
  const c = done ? 'var(--ink-300)' : active ? 'var(--signal)' : 'var(--ink-500)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', borderRadius: 3,
      background: active ? 'color-mix(in oklch, var(--signal) 8%, transparent)' : 'transparent',
      border: active ? '1px solid var(--signal-deep)' : '1px solid transparent',
    }}>
      <span className="mono" style={{ fontSize: 10, color: c, letterSpacing: '0.04em', fontWeight: 700 }}>{n}</span>
      <span className="sans" style={{ fontSize: 13, color: active ? 'var(--ink-100)' : 'var(--ink-200)', fontWeight: active ? 600 : 400 }}>{name}</span>
      {done && <span style={{ marginLeft: 'auto', color: 'var(--signal)', fontSize: 12 }}>✓</span>}
    </div>
  );
}

function RoleSetupRow({ role, last }) {
  return (
    <div style={{
      padding: '14px 18px',
      borderBottom: last ? 'none' : '1px solid var(--ink-600)',
      display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div className="mono" style={{
        width: 56, fontSize: 12, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em',
      }}>{role.code}</div>
      <div style={{ flex: 1 }}>
        <div className="sans" style={{ fontSize: 14, color: 'var(--ink-100)', fontWeight: 600 }}>{role.name}</div>
        <div className="sans" style={{ fontSize: 12, color: 'var(--ink-300)', marginTop: 2 }}>{role.desc}</div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <PillBtn active={role.active}>ACTIVE</PillBtn>
        <PillBtn active={role.standby} tone="warn">STANDBY</PillBtn>
        <PillBtn>OFF</PillBtn>
      </div>
    </div>
  );
}

function PillBtn({ children, active, tone }) {
  const activeColor = tone === 'warn' ? 'var(--warn)' : 'var(--signal)';
  return (
    <button className="mono" style={{
      background: active ? `color-mix(in oklch, ${activeColor} 16%, transparent)` : 'transparent',
      color: active ? activeColor : 'var(--ink-300)',
      border: active ? `1px solid ${activeColor}` : '1px solid var(--ink-500)',
      padding: '5px 12px', borderRadius: 2,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', cursor: 'pointer',
    }}>{children}</button>
  );
}

/* ============================================================
   03 — CREATOR · ENVIRONMENT
*/
function AppEnvironment() {
  return (
    <div style={{
      width: '100%', height: '100%', background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
    }}>
      <AppTopBar session="DRAFT-04" state="SETUP" turn={0} elapsed="—" />
      <div style={{ flex: 1, padding: '36px 64px', overflow: 'hidden' }}>
        <Eyebrow color="var(--signal)">step 02 · environment</Eyebrow>
        <h1 className="sans" style={{
          fontSize: 32, fontWeight: 600, color: 'var(--ink-050)',
          margin: '8px 0 4px', letterSpacing: '-0.02em',
        }}>What does the environment look like?</h1>
        <p className="sans" style={{
          fontSize: 14, color: 'var(--ink-300)', margin: '0 0 24px', maxWidth: 720, lineHeight: 1.5,
        }}>
          The AI uses this to ground injects. Synthetic logs reference real hostnames. Vendor names
          appear in the threat model. The more concrete this is, the less the simulation feels generic.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <EnvField label="ORGANIZATION TYPE" value="Mid-size museum · 600 employees · public-facing site + donor portal" />
          <EnvField label="EDR / XDR" value="Microsoft Defender for Endpoint · Sentinel SIEM" />
          <EnvField label="IDENTITY" value="Entra ID · 1,200 active accounts · MFA enforced" />
          <EnvField label="CROWN JEWELS" value="Donor records (~280K) · gift-card & ticketing DB · collections-management software" />
          <EnvField label="EXTERNAL EXPOSURE" value="amnh.org · members.amnh.org · ticketing.amnh.org · 2 marketing landing sites" />
          <EnvField label="ON-CALL DEPTH" value="Tier-1: 24/7 outsourced SOC · Tier-2: 2 internal engineers, business hours" />
        </div>
      </div>
    </div>
  );
}

function EnvField({ label, value }) {
  return (
    <div style={{
      padding: 16, background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4,
    }}>
      <div className="mono" style={{
        fontSize: 10, color: 'var(--signal)', letterSpacing: '0.20em', fontWeight: 700, marginBottom: 8,
      }}>{label}</div>
      <div className="sans" style={{ fontSize: 13, color: 'var(--ink-100)', lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}

/* ============================================================
   04 — CREATOR · INVITE / LOBBY
*/
function AppLobby() {
  const sessionUrl = 'https://crittable.app/j/PRM09-X42';
  const players = [
    { code: 'IC',  name: 'R. Briggs',  joined: true,  ready: true,  you: true },
    { code: 'CSM', name: 'A. Park',    joined: true,  ready: true },
    { code: 'CSE', name: 'D. Okafor',  joined: true,  ready: false },
    { code: 'COM', name: '— pending invite —', joined: false },
  ];
  return (
    <div style={{
      width: '100%', height: '100%', background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
    }}>
      <AppTopBar session="PROMETHEUS-09" state="LOBBY" turn={0} elapsed="—" />
      <div style={{ flex: 1, padding: 36, display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <Eyebrow color="var(--signal)">step 05 · invite players</Eyebrow>
            <h1 className="sans" style={{ fontSize: 32, fontWeight: 600, color: 'var(--ink-050)', margin: '8px 0 0', letterSpacing: '-0.02em' }}>Lobby · 3 of 4 joined</h1>
          </div>
          <div style={{
            background: 'var(--ink-850)', border: '1px solid var(--signal-deep)', borderRadius: 4, padding: 18,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--signal)', letterSpacing: '0.20em', fontWeight: 700 }}>JOIN LINK</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code className="mono" style={{
                flex: 1, padding: '10px 14px',
                background: 'var(--ink-900)', border: '1px solid var(--ink-600)', borderRadius: 2,
                fontSize: 14, color: 'var(--ink-100)',
              }}>{sessionUrl}</code>
              <button className="mono" style={{
                background: 'var(--signal)', color: 'var(--ink-900)', border: 'none',
                padding: '10px 16px', borderRadius: 2, fontWeight: 700,
                fontSize: 11, letterSpacing: '0.16em', cursor: 'pointer',
              }}>COPY</button>
            </div>
            <div className="sans" style={{ fontSize: 12, color: 'var(--ink-300)' }}>
              Anyone with this link can join. Players pick their role from the open seats.
            </div>
          </div>
          <div style={{ background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4 }}>
            {players.map((p, i, arr) => (
              <LobbyRow key={p.code} p={p} last={i === arr.length - 1} />
            ))}
          </div>
        </div>
        <div style={{
          background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4, padding: 24,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <Eyebrow color="var(--signal)">scenario · ready</Eyebrow>
          <div className="sans" style={{ fontSize: 18, color: 'var(--ink-050)', fontWeight: 600 }}>Defacement + Exfil · AMNH</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-300)', lineHeight: 1.6 }}>
            6 ROLES · 4 ACTIVE<br/>
            ~90 MIN · 3 INJECTS QUEUED<br/>
            SEV: HIGH<br/>
            RECOVERY CASCADES: ENABLED
          </div>
          <div style={{ flex: 1 }} />
          <button className="mono" style={{
            background: 'var(--signal)', color: 'var(--ink-900)', border: 'none',
            padding: '14px', borderRadius: 2, fontWeight: 700,
            fontSize: 13, letterSpacing: '0.20em', cursor: 'pointer',
          }}>START SESSION →</button>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-400)', textAlign: 'center' }}>
            STARTING TRANSITIONS STATE → BRIEFING → AI_PROCESSING
          </div>
        </div>
      </div>
    </div>
  );
}

function LobbyRow({ p, last }) {
  return (
    <div style={{
      padding: '14px 18px',
      borderBottom: last ? 'none' : '1px solid var(--ink-600)',
      display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div className="mono" style={{
        width: 56, fontSize: 12, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em',
      }}>{p.code}</div>
      <div style={{ flex: 1 }}>
        <div className="sans" style={{ fontSize: 14, color: p.joined ? 'var(--ink-100)' : 'var(--ink-400)', fontWeight: 500 }}>
          {p.name}{p.you && <span className="mono" style={{ color: 'var(--signal)', marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: '0.18em' }}>· YOU</span>}
        </div>
      </div>
      {p.joined ? (
        p.ready
          ? <StatusChip label="●" value="READY" tone="signal" />
          : <StatusChip label="◐" value="JOINED" tone="warn" />
      ) : (
        <button className="mono" style={{
          background: 'transparent', color: 'var(--ink-200)', border: '1px dashed var(--ink-500)',
          padding: '6px 14px', borderRadius: 2,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.16em', cursor: 'pointer',
        }}>+ COPY INVITE</button>
      )}
    </div>
  );
}

/* ============================================================
   05 — PLAYER · JOIN SCREEN
*/
function AppPlayerJoin() {
  const seats = [
    { code: 'IC', name: 'Incident Commander', taken: true, by: 'R. Briggs' },
    { code: 'CSM', name: 'Cybersecurity Manager', taken: true, by: 'A. Park' },
    { code: 'CSE', name: 'Cybersecurity Engineer', open: true, recommended: true },
    { code: 'COM', name: 'Comms / Legal', open: true },
  ];
  return (
    <div style={{
      width: '100%', height: '100%', background: 'var(--ink-900)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif",
      position: 'relative', overflow: 'hidden',
    }}>
      <div className="dotgrid" style={{ position: 'absolute', inset: 0, opacity: 0.6 }} />
      <div style={{
        position: 'relative', zIndex: 1,
        width: 580, padding: 36,
        background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4,
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Mark size={48} brand="playbook" />
          <div>
            <Eyebrow color="var(--signal)">join session</Eyebrow>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.06em', marginTop: 4 }}>
              PROMETHEUS-09
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <StatusChip label="HOST" value="R. BRIGGS" />
        </div>
        <div className="sans" style={{ fontSize: 14, color: 'var(--ink-200)', lineHeight: 1.5 }}>
          You've been invited to a tabletop exercise. Pick your role and confirm your name.
        </div>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-300)', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 8 }}>YOUR NAME</div>
          <div style={{
            padding: '12px 14px', background: 'var(--ink-900)', border: '1px solid var(--signal-deep)',
            borderRadius: 2, color: 'var(--ink-100)', fontSize: 14,
          }}>D. Okafor<span className="blink" style={{ color: 'var(--signal)', fontWeight: 700, marginLeft: 2 }}>▍</span></div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-300)', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 8 }}>PICK A SEAT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {seats.map(s => <SeatRow key={s.code} s={s} />)}
          </div>
        </div>
        <button className="mono" style={{
          background: 'var(--signal)', color: 'var(--ink-900)', border: 'none',
          padding: '14px', borderRadius: 2, fontWeight: 700,
          fontSize: 12, letterSpacing: '0.20em', cursor: 'pointer', marginTop: 8,
        }}>JOIN AS CSE → READY ROOM</button>
      </div>
    </div>
  );
}

function SeatRow({ s }) {
  if (s.taken) {
    return (
      <div style={{
        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--ink-900)', border: '1px solid var(--ink-700)', borderRadius: 2, opacity: 0.55,
      }}>
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em', width: 48 }}>{s.code}</span>
        <span className="sans" style={{ fontSize: 13, color: 'var(--ink-300)', flex: 1 }}>{s.name}</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.10em' }}>{s.by} · taken</span>
      </div>
    );
  }
  const recommended = s.recommended;
  return (
    <button style={{
      padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
      background: recommended ? 'color-mix(in oklch, var(--signal) 10%, var(--ink-900))' : 'var(--ink-900)',
      border: `1px solid ${recommended ? 'var(--signal)' : 'var(--ink-500)'}`, borderRadius: 2,
      cursor: 'pointer', color: 'var(--ink-100)',
    }}>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em', width: 48 }}>{s.code}</span>
      <span className="sans" style={{ fontSize: 13, flex: 1 }}>{s.name}</span>
      {recommended && <StatusChip label="●" value="RECOMMENDED" tone="signal" />}
    </button>
  );
}

/* ============================================================
   06 — PLAYER · BRIEFING / READY ROOM
*/
function AppBriefing() {
  return (
    <div style={{
      width: '100%', height: '100%', background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
    }}>
      <AppTopBar session="PROMETHEUS-09" state="BRIEFING" turn={0} elapsed="00:00:14" />
      <div style={{ flex: 1, padding: '32px 48px', display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, overflow: 'hidden' }}>
          <div>
            <Eyebrow color="var(--signal)">your role · CSE</Eyebrow>
            <h1 className="sans" style={{ fontSize: 32, fontWeight: 600, color: 'var(--ink-050)', margin: '8px 0 4px', letterSpacing: '-0.02em' }}>Cybersecurity Engineer</h1>
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-300)', letterSpacing: '0.04em' }}>
              hands-on triage · containment · evidence handling
            </div>
          </div>
          <BriefBlock title="WHAT YOU OWN">
            Containment actions on hosts and identities. Evidence collection and chain-of-custody.
            Direct technical triage of suspected compromise. You are not the decision-maker on
            disclosure or external comms.
          </BriefBlock>
          <BriefBlock title="WHAT TO EXPECT">
            The AI facilitator will route turns to you when technical action is required. You can
            request a pause at any time by submitting <span className="mono" style={{ color: 'var(--signal)' }}>?</span> followed
            by a question — this is the <em>interject</em> path, it doesn't change session state.
          </BriefBlock>
          <BriefBlock title="HOUSE RULES">
            Treat the simulation as real. No meta-commentary in the response window.
            Time pressure is part of the exercise — partial answers are better than late ones.
            The AAR will replay everything.
          </BriefBlock>
        </div>
        <div style={{ background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Eyebrow color="var(--signal)">waiting on</Eyebrow>
          <div className="mono" style={{ fontSize: 36, color: 'var(--ink-050)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>1</div>
          <div className="sans" style={{ fontSize: 13, color: 'var(--ink-200)', lineHeight: 1.5 }}>
            COM · Comms / Legal hasn't joined yet.
          </div>
          <div style={{ flex: 1 }} />
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-400)', letterSpacing: '0.16em' }}>
            HOST CAN START EARLY
          </div>
        </div>
      </div>
    </div>
  );
}

function BriefBlock({ title, children }) {
  return (
    <div style={{ padding: '14px 18px', background: 'var(--ink-850)', borderLeft: '2px solid var(--signal)', borderRadius: '0 3px 3px 0' }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--signal)', letterSpacing: '0.20em', fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div className="sans" style={{ fontSize: 13, color: 'var(--ink-100)', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/* ============================================================
   07 — POST-SESSION · AAR
*/
function AppAAR() {
  return (
    <div style={{
      width: '100%', height: '100%', background: 'var(--ink-900)',
      display: 'flex', flexDirection: 'column',
    }}>
      <AppTopBar session="PROMETHEUS-09" state="ENDED" turn={14} elapsed="01:38:42" />
      <div style={{ flex: 1, padding: '32px 48px', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
          <div>
            <Eyebrow color="var(--signal)">after-action report</Eyebrow>
            <h1 className="sans" style={{ fontSize: 32, fontWeight: 600, color: 'var(--ink-050)', margin: '8px 0 0', letterSpacing: '-0.02em' }}>Defacement + Exfil · debrief</h1>
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-300)', marginTop: 4 }}>14 TURNS · 0 STUCK · 1H 38M · GENERATED 2026-04-30 14:22 UTC</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <ScoreCard label="CONTAINMENT" value="B+" tone="signal" />
            <ScoreCard label="COMMS" value="A−" tone="signal" />
            <ScoreCard label="DECISION SPEED" value="C" tone="warn" />
          </div>
          <BriefBlock title="WHAT WORKED">
            CSM correctly held on the donor-record claim until schema comparison was complete.
            IC's escalation of legal via sidebar (not chat) preserved decision-making clarity.
            CSE produced an upd.exe artifact within 3 minutes of being routed to.
          </BriefBlock>
          <BriefBlock title="WHAT DIDN'T">
            17 minutes elapsed between defacement detection and the first containment action.
            COM was activated 4 turns later than the scenario rewards. Newsletter decision was
            deferred without explicit owner.
          </BriefBlock>
          <BriefBlock title="RECOMMENDATIONS">
            Define a default owner for "external messaging during active incident."
            Pre-stage donor-record schema diff as a runbook artifact.
            Practice the sidebar-vs-chat decision rubric — currently implicit.
          </BriefBlock>
        </div>
        <div style={{ background: 'var(--ink-850)', border: '1px solid var(--ink-600)', borderRadius: 4, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'hidden' }}>
          <Eyebrow>per-role scoring</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <RoleScore code="IC" name="R. Briggs" decisions={6} grade="A−" />
            <RoleScore code="CSM" name="A. Park" decisions={5} grade="B+" />
            <RoleScore code="CSE" name="D. Okafor" decisions={4} grade="B" />
            <RoleScore code="COM" name="M. Hanover" decisions={2} grade="C+" />
          </div>
          <div style={{ borderTop: '1px solid var(--ink-600)', paddingTop: 14, marginTop: 4 }}>
            <Eyebrow>export</Eyebrow>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              <AdminBtn>PDF REPORT</AdminBtn>
              <AdminBtn>JSON TIMELINE</AdminBtn>
              <AdminBtn>SLACK SUMMARY</AdminBtn>
              <AdminBtn>RUNBOOK DIFF</AdminBtn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreCard({ label, value, tone }) {
  const c = tone === 'signal' ? 'var(--signal)' : tone === 'warn' ? 'var(--warn)' : 'var(--ink-100)';
  return (
    <div style={{
      padding: 18, background: 'var(--ink-850)', border: `1px solid ${c}`, borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div className="mono" style={{ fontSize: 9, color: 'var(--ink-300)', letterSpacing: '0.20em', fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 36, color: c, fontWeight: 700, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function RoleScore({ code, name, decisions, grade }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--ink-800)', border: '1px solid var(--ink-600)', borderRadius: 2 }}>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-100)', letterSpacing: '0.10em', width: 44 }}>{code}</span>
      <span className="sans" style={{ fontSize: 13, color: 'var(--ink-200)', flex: 1 }}>{name}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-400)' }}>{decisions} DECISIONS</span>
      <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--signal)', width: 28, textAlign: 'right' }}>{grade}</span>
    </div>
  );
}

Object.assign(window, {
  AppTacticalHUD, AppCreatorSetup, AppEnvironment, AppLobby,
  AppPlayerJoin, AppBriefing, AppAAR,
});
