## Timeline

- T+00:00 — Detection / first signal
- T+__:__ — Incident declared, IC assigned
- T+__:__ — Affected systems isolated
- T+__:__ — Ransom demand received / reviewed
- T+__:__ — Recovery decision (pay / restore / mixed)

## Action Items

- [ ] Isolate affected hosts from network
- [ ] Snapshot a clean machine for forensics before reboot
- [ ] Verify backup integrity and recovery RPO/RTO
- [ ] Engage cyber-insurance carrier (24h clock starts now)
- [ ] Decide on ransom-call posture and assign negotiator
- [ ] Notify customers / regulators per breach-notification rules
- [ ] Prepare holding statement for press / investors

## Decisions

- Ransom posture: _negotiate / decline / under review_
- Recovery path: _restore from backup / pay / parallel_
- Public disclosure timing: _initial holding / wait for facts_

## Open Questions

- Are the backups offline, immutable, and tested?
- What's the customer-data exposure (PII, payment, credentials)?
- Has the threat actor exfiltrated data, or is this encryption-only?
