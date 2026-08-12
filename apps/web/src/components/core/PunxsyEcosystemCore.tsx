"use client";

import { useEffect, useMemo, useReducer } from "react";

export interface TelemetryLog {
  timestampZulu: string;
  route: "/system_control/pending/";
  event: string;
  payload: Record<string, unknown>;
}

export interface RoleConfig {
  name:
    | "Athlete"
    | "Guardian"
    | "Coach"
    | "Admin"
    | "President"
    | "Vice Chair"
    | "Treasurer"
    | "Secretary"
    | "Program & Safety Director"
    | "Community Director"
    | "Director-at-Large"
    | "Auditor";
  buildStatus: "BUILT" | "PARTIALLY SCAFFOLDED";
  purposeStatement: string;
  privacyTier: string;
  restrictedModules: string[];
}

export interface AppState {
  selectedRole: RoleConfig["name"];
  verified_by_jason: boolean;
  telemetryLogs: TelemetryLog[];
  roles: RoleConfig[];
}

type AppAction =
  | { type: "SET_ROLE"; payload: RoleConfig["name"] }
  | { type: "TOGGLE_VERIFIED_BY_JASON" }
  | { type: "APPEND_TELEMETRY"; payload: TelemetryLog };

const ROLE_CONFIGS: RoleConfig[] = [
  {
    name: "Athlete",
    buildStatus: "BUILT",
    purposeStatement:
      "Tracks training intent, personal milestones, and approved session visibility under strict guardian policy overlays.",
    privacyTier: "Tier-2 Sensitive",
    restrictedModules: ["Org Ledger", "Safety Escalation Queue", "Board Vote Matrix"],
  },
  {
    name: "Guardian",
    buildStatus: "BUILT",
    purposeStatement:
      "Maintains minor-safe oversight, access approvals, and communication controls for dependent athletes.",
    privacyTier: "Tier-1 Minor-Safe",
    restrictedModules: ["Board Finance Console", "Coach Credential Drafts", "Admin Root Controls"],
  },
  {
    name: "Coach",
    buildStatus: "BUILT",
    purposeStatement:
      "Operates class readiness, progression oversight, and injury-safe conditioning controls.",
    privacyTier: "Tier-2 Sensitive",
    restrictedModules: ["Treasury Journal", "Board Deliberation Records", "Audit Workbench"],
  },
  {
    name: "Admin",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Handles deterministic user operations, records lifecycle, and access remediations.",
    privacyTier: "Tier-3 Operational",
    restrictedModules: ["Board Deliberation Records", "Auditor Exception Vault"],
  },
  {
    name: "President",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Directs strategic governance and cross-role policy execution across the ecosystem core.",
    privacyTier: "Tier-4 Governance",
    restrictedModules: ["Minor Identity Registry", "Medical Redaction Queue"],
  },
  {
    name: "Vice Chair",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Provides board continuity support, governance fallback, and policy verification operations.",
    privacyTier: "Tier-4 Governance",
    restrictedModules: ["Minor Identity Registry", "Raw Incident Attachments"],
  },
  {
    name: "Treasurer",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Maintains revenue integrity, expense attestations, and budget exposure controls.",
    privacyTier: "Tier-4 Financial",
    restrictedModules: ["Minor Guardian Messaging", "Coach Performance Notes"],
  },
  {
    name: "Secretary",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Captures records-of-truth, board artifacts, and immutable meeting accountability.",
    privacyTier: "Tier-3 Governance",
    restrictedModules: ["Medical Escalation Attachments", "Private Finance Drafts"],
  },
  {
    name: "Program & Safety Director",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Coordinates coaching safety protocol and adverse-event control loops.",
    privacyTier: "Tier-4 Safety",
    restrictedModules: ["Treasury Payroll Matrix", "Board Compensation Review"],
  },
  {
    name: "Community Director",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Shapes outreach execution and event-state coordination with deterministic approvals.",
    privacyTier: "Tier-2 Public-Edge",
    restrictedModules: ["Minor Incident Queue", "Audit Exception Vault"],
  },
  {
    name: "Director-at-Large",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Supports board-level oversight across strategy, compliance, and cross-domain checks.",
    privacyTier: "Tier-3 Governance",
    restrictedModules: ["Medical Escalation Records", "Raw Athlete Intake Docs"],
  },
  {
    name: "Auditor",
    buildStatus: "PARTIALLY SCAFFOLDED",
    purposeStatement:
      "Validates control evidence, operational integrity, and deterministic policy conformance.",
    privacyTier: "Tier-5 Audit",
    restrictedModules: ["Live Guardian Contact Channels", "Coach Session Drafts"],
  },
];

const initialState: AppState = {
  selectedRole: "Athlete",
  verified_by_jason: false,
  telemetryLogs: [],
  roles: ROLE_CONFIGS,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_ROLE":
      return {
        ...state,
        selectedRole: action.payload,
      };
    case "TOGGLE_VERIFIED_BY_JASON":
      return {
        ...state,
        verified_by_jason: !state.verified_by_jason,
      };
    case "APPEND_TELEMETRY":
      return {
        ...state,
        telemetryLogs: [...state.telemetryLogs, action.payload],
      };
    default:
      return state;
  }
}

function makeTelemetry(event: string, payload: Record<string, unknown>): TelemetryLog {
  return {
    timestampZulu: new Date().toISOString(),
    route: "/system_control/pending/",
    event,
    payload,
  };
}

export default function PunxsyEcosystemCore() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const activeRole = useMemo(
    () => state.roles.find((role) => role.name === state.selectedRole) ?? state.roles[0],
    [state.roles, state.selectedRole],
  );

  const dispatchWithTelemetry = (
    action: Exclude<AppAction, { type: "APPEND_TELEMETRY" }>,
    event: string,
    payload: Record<string, unknown>,
  ) => {
    dispatch(action);
    dispatch({ type: "APPEND_TELEMETRY", payload: makeTelemetry(event, payload) });
  };

  useEffect(() => {
    dispatch({
      type: "APPEND_TELEMETRY",
      payload: makeTelemetry("SYSTEM_BOOT", {
        selectedRole: initialState.selectedRole,
        verified_by_jason: initialState.verified_by_jason,
      }),
    });
  }, []);

  return (
    <section className="bg-[#09090b] text-slate-300 font-mono border border-zinc-800 rounded-none min-h-screen w-full p-2 text-xs">
      <header className="border border-zinc-800 rounded-none p-2">
        <h1 className="font-mono text-slate-300 text-[12px] tracking-tight">
          PUNXSY PROMINENCE ADAPTIVE BOXING PLATFORM v21.1
        </h1>
        <div className="mt-2 border border-zinc-800 rounded-none p-2 text-[#b91c1c] animate-pulse">
          <span className="bg-[#b91c1c] text-[#09090b] px-1 mr-2">ALERT</span>
          ⚠️ WARNING: Live access permissions detached. System running in mock-only front-end
          simulation mode.
        </div>
      </header>

      <div className="border border-zinc-800 rounded-none p-2 mt-2">
        <h2 className="text-slate-300 text-[11px] mb-2">ROLE SWITCHER MATRIX (12-ROLE GRID)</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1">
          {state.roles.map((role) => {
            const isActive = role.name === state.selectedRole;
            return (
              <button
                key={role.name}
                type="button"
                onClick={() => {
                  dispatchWithTelemetry(
                    { type: "SET_ROLE", payload: role.name },
                    "SET_ROLE",
                    {
                      selectedRole: role.name,
                      buildStatus: role.buildStatus,
                    },
                  );
                }}
                className={[
                  "border border-zinc-800 rounded-none p-2 text-left bg-[#09090b]",
                  isActive ? "text-[#b91c1c]" : "text-slate-300",
                ].join(" ")}
              >
                <div className="text-[11px] leading-tight">{role.name}</div>
                <div className="text-[10px] mt-1">[{role.buildStatus}]</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border border-zinc-800 rounded-none p-2 mt-2">
        <h2 className="text-slate-300 text-[11px]">ACTIVE ROLE VIEWPORT</h2>
        <div className="mt-2 border border-zinc-800 rounded-none p-2 bg-[#09090b]">
          <p className="text-[11px]">Role: {activeRole.name}</p>
          <p className="text-[11px] mt-1">Purpose Statement: {activeRole.purposeStatement}</p>
          <p className="text-[11px] mt-1">Privacy Tier: {activeRole.privacyTier}</p>
          <div className="mt-1">
            <p className="text-[11px]">Restricted Modules:</p>
            <ul className="mt-1">
              {activeRole.restrictedModules.map((moduleName) => (
                <li key={moduleName} className="text-[11px]">
                  - {moduleName}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="border border-zinc-800 rounded-none p-2 mt-2">
        <h2 className="text-slate-300 text-[11px]">
          TELEMETRY TERMINAL CONSOLE (L38) /system_control/pending/
        </h2>
        <div className="mt-2 bg-black border border-zinc-800 rounded-none p-2 h-44 overflow-auto font-mono text-[9px] text-slate-300">
          {state.telemetryLogs.length === 0 ? (
            <pre>{JSON.stringify({ status: "NO TELEMETRY" }, null, 2)}</pre>
          ) : (
            state.telemetryLogs.map((log, index) => (
              <pre key={`${log.timestampZulu}-${index}`} className="mb-2">
                {JSON.stringify(log, null, 2)}
              </pre>
            ))
          )}
        </div>
      </div>

      <footer className="border border-zinc-800 rounded-none p-2 mt-2">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div className="text-[11px]">
            <span className="border border-zinc-800 rounded-none px-1 py-[2px] text-[#b91c1c]">
              Pending Coach Verification Flag
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]">
              {JSON.stringify({ verified_by_jason: state.verified_by_jason })}
            </span>
            <button
              type="button"
              className="border border-zinc-800 rounded-none px-2 py-1 bg-[#09090b] text-slate-300"
              onClick={() => {
                dispatchWithTelemetry(
                  { type: "TOGGLE_VERIFIED_BY_JASON" },
                  "TOGGLE_VERIFIED_BY_JASON",
                  { verified_by_jason: !state.verified_by_jason },
                );
              }}
            >
              Toggle verified_by_jason
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}
