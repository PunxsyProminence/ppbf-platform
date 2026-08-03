"use client";

import { useMemo, useState } from "react";
import RoleSessionGate from '@/components/RoleSessionGate';
import Link from "next/link";
import { ThemeToggle, useThemeOptional } from "@/components/ThemeProvider";

type LedgerLine = {
  id: string;
  time: string;
  text: string;
};

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function RetroLabPageContent() {
  const { isRetro } = useThemeOptional();
  const [ledger, setLedger] = useState<LedgerLine[]>([
    { id: "1", time: "14:01", text: "SYSTEM  READY  Continuity ledger online" },
    { id: "2", time: "14:08", text: "SYSTEM  OPENED  Sample ticket  (no athlete)" },
  ]);
  const [caseStamp, setCaseStamp] = useState<"HOLD" | "CLEARED" | "RESTRICTED" | null>("HOLD");
  const [pin, setPin] = useState("");
  const [attendance, setAttendance] = useState<Record<string, string>>({
    "Sample row A": "",
    "Sample row B": "PRESENT",
    "Sample row C": "",
  });
  const [roundActive, setRoundActive] = useState(false);
  const [punches, setPunches] = useState({ jab: 0, cross: 0, hook: 0 });

  function pushLedger(text: string) {
    setLedger((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, time: nowTime(), text },
    ]);
  }

  function stampCase(code: "CLEARED" | "HOLD" | "RESTRICTED") {
    setCaseStamp(code);
    pushLedger(`STAMPED ${code}  Sample ticket  (no athlete)`);
  }

  function stampAttendance(name: string, code: string) {
    setAttendance((prev) => ({ ...prev, [name]: code }));
    pushLedger(`COACH YOU  STAMPED ${code}  ${name}`);
  }

  function keyPin(digit: string) {
    setPin((p) => (p.length >= 4 ? p : p + digit));
  }

  const scoreboard = useMemo(
    () =>
      `OPEN: ${caseStamp === "HOLD" || !caseStamp ? 1 : 0} │ PRESENT: ${Object.values(attendance).filter((v) => v === "PRESENT").length} │ THEME: ${isRetro ? "RETRO" : "TACTICAL"}`,
    [caseStamp, attendance, isRetro],
  );

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 lg:px-8">
        <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.35em]">PPBF · Design Lab (component samples, not records)</p>
              <h1 className="font-display text-3xl uppercase tracking-wide">Retro Lab</h1>
              <p className="mt-1 max-w-2xl text-sm text-[var(--gray-dark)]">
                Toggle the theme, press stamps, and watch the ledger. Existing pages pick up the retro
                palette automatically via CSS variables.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ThemeToggle />
              <Link href="/login" className="brass-plate brass-plate--label no-underline">
                Login
              </Link>
              <Link href="/operations" className="leather-tag no-underline">
                Operations
              </Link>
            </div>
          </div>
          <div className="brass-scoreboard" role="status">
            <span>{scoreboard}</span>
            <span className={`stamp-button stamp-button--static ${isRetro ? "stamp-button--cleared" : "stamp-button--neutral"}`}>
              {isRetro ? "RETRO ON" : "TACTICAL"}
            </span>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          {/* Left: interactive desks */}
          <div className="space-y-6">
            {/* Review ticket */}
            <section className="paper-ticket">
              <div className="paper-ticket__head">
                <span className="paper-ticket__id">Sample ticket</span>
                {caseStamp ? (
                  <span className={`stamp-button stamp-button--static stamp-button--${caseStamp.toLowerCase()}`}>
                    {caseStamp}
                  </span>
                ) : null}
              </div>
              <h2 className="font-display text-xl uppercase">Sample review ticket (no athlete)</h2>
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--gray-dark)]">
                Component sample — this ticket is not a record and decides nothing
              </p>
              <div className="paper-ticket__actions">
                <button type="button" className="stamp-button stamp-button--cleared" onClick={() => stampCase("CLEARED")}>
                  CLEARED
                </button>
                <button type="button" className="stamp-button stamp-button--hold" onClick={() => stampCase("HOLD")}>
                  HOLD
                </button>
                <button
                  type="button"
                  className="stamp-button stamp-button--restricted"
                  onClick={() => stampCase("RESTRICTED")}
                >
                  RESTRICTED
                </button>
              </div>
            </section>

            {/* Attendance */}
            <section className="tactical-panel space-y-3 p-4">
              <h2 className="font-display text-lg uppercase tracking-wide">Live Attendance</h2>
              <div className="space-y-3">
                {Object.entries(attendance).map(([name, status]) => (
                  <div key={name} className="paper-ticket">
                    <div className="paper-ticket__head">
                      <strong className="font-display uppercase">{name}</strong>
                      {status ? (
                        <span className={`stamp-button stamp-button--static stamp-button--${status === "PRESENT" ? "present" : status === "LATE" ? "hold" : "neutral"}`}>
                          {status}
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] uppercase">Unmarked</span>
                      )}
                    </div>
                    <div className="paper-ticket__actions">
                      <button
                        type="button"
                        className="stamp-button stamp-button--present"
                        onClick={() => stampAttendance(name, "PRESENT")}
                      >
                        PRESENT
                      </button>
                      <button
                        type="button"
                        className="stamp-button stamp-button--hold"
                        onClick={() => stampAttendance(name, "LATE")}
                      >
                        LATE
                      </button>
                      <button
                        type="button"
                        className="stamp-button stamp-button--neutral"
                        onClick={() => stampAttendance(name, "ABSENT")}
                      >
                        ABSENT
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Sparring mini */}
            <section className="tactical-panel space-y-3 p-4">
              <h2 className="font-display text-lg uppercase tracking-wide">Sparring Log (mini)</h2>
              <p className="font-mono text-xs uppercase">Athlete vs Opponent · Floor one-handed test</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="brass-plate"
                  onClick={() => {
                    setRoundActive(true);
                    setPunches({ jab: 0, cross: 0, hook: 0 });
                    pushLedger("COACH YOU  START ROUND  Sample round");
                  }}
                >
                  START ROUND
                </button>
                <button
                  type="button"
                  className="brass-plate"
                  disabled={!roundActive}
                  onClick={() => {
                    setRoundActive(false);
                    pushLedger(
                      `COACH YOU  END ROUND  Sample round  J${punches.jab} C${punches.cross} H${punches.hook}`,
                    );
                  }}
                >
                  END ROUND
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["jab", "cross", "hook"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="stamp-button stamp-button--neutral"
                    disabled={!roundActive}
                    onClick={() => setPunches((p) => ({ ...p, [key]: p[key] + 1 }))}
                  >
                    {key.toUpperCase()} {punches[key]}
                  </button>
                ))}
              </div>
              <p className="font-mono text-xs">
                Round: {roundActive ? "ACTIVE" : "IDLE"} · use large stamps with gloves on
              </p>
            </section>

            {/* PIN pad */}
            <section className="tactical-panel p-4">
              <h2 className="font-display text-lg uppercase tracking-wide">Mechanical PIN</h2>
              <div className="mechanical-lock mt-3">
                <div className="mechanical-lock__display">{pin.padEnd(4, "·")}</div>
                <div className="mechanical-lock__keys">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        if (k === "C") setPin("");
                        else if (k === "⌫") setPin((p) => p.slice(0, -1));
                        else keyPin(k);
                      }}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="brass-plate"
                  onClick={() => {
                    pushLedger(`SYSTEM  PIN ENTRY  length=${pin.length}`);
                    setPin("");
                  }}
                >
                  ENTER
                </button>
              </div>
            </section>

            {/* Capability lockers */}
            <section className="tactical-panel p-4">
              <h2 className="font-display text-lg uppercase tracking-wide">Capability Lockers</h2>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ["People", "59 Active"],
                  ["PIN Mgmt", "104 Keys"],
                  ["Compliance", "98% Pass"],
                  ["Volunteers", "21 Active"],
                  ["Scheduling", "15 Classes"],
                  ["System", "All Green"],
                ].map(([label, metric], i) => (
                  <div key={label} className="gym-locker-tile">
                    {i === 1 ? <span className="badge-restricted">▲ RESTRICTED</span> : null}
                    <span className="gym-locker-tile__label">{label}</span>
                    <span className="gym-locker-tile__metric">{metric}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Right: ledger */}
          <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
            <div className="ledger-tape" role="log" aria-live="polite">
              <div className="ledger-tape__edge ledger-tape__edge--top" />
              <ol className="ledger-tape__entries">
                {ledger.map((line) => (
                  <li key={line.id}>
                    <time>{line.time}</time>
                    {line.text}
                  </li>
                ))}
              </ol>
              <div className="ledger-tape__edge ledger-tape__edge--bottom" />
            </div>
            <p className="font-mono text-[11px] uppercase leading-relaxed text-[var(--gray-dark)]">
              How to test on live app:
              <br />1. Click <strong>Theme: Retro</strong> (persists in localStorage)
              <br />2. Walk any existing page — colors shift
              <br />3. Press stamps here — ledger appends
              <br />4. Phone: stamps grow to 56px for floor use
            </p>
            <Link href="/" className="leather-tag inline-flex no-underline">
              Home
            </Link>
          </aside>
        </div>
      </div>
    </main>
  );
}

export default function RetroLabPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <RetroLabPageContent />
    </RoleSessionGate>
  );
}
