# External audit prompts

Prompts for handing this platform to a model that did not build it — Grok, GPT, Gemini,
whatever is at hand. They exist because the agents that wrote this code cannot audit their own
assumptions, and the failure mode is documented: three separate findings in this repo were
asserted by an audit and turned out to be false when someone finally checked. The four
`chat_audit` tables "in production" were not in production. The design lab's `canManagePeople`
guard "missing" was already there. A Postgres failure diagnosed twice as "environmental
contention" was a box-drawing character in a SQL file.

An outside model is worth the trouble precisely where it has no stake in believing us.

---

## Before you paste anything

This is a private repository for a nonprofit serving minors. Sending code to an external model
sends it to that vendor.

**Never paste:** `apps/web/.env.local`, any connection string, `AZURE_*` values,
`PPBF_MS_CLIENT_SECRET`, `PPBF_PILOT_BOOTSTRAP_KEY`, any real athlete or guardian name, any
real PIN or account id, anything out of `scripts/data/`.

**Safe to paste:** application source, tests, migrations, and the `docs/` files named below.
None of them carry secrets or personal data.

If a prompt needs a file, say so and paste the file. Do not paraphrase source to a model and
then trust its answer about the source — that is how you get a confident audit of code that
does not exist.

---

## Context block — paste this once, first

> You are auditing the platform for the Punxsutawney Prominence Boxing Foundation, a registered
> nonprofit youth boxing gym. The users are children aged roughly 8-18, their parents and legal
> guardians, volunteer coaches, an organization administrator, an aggregate-only board, and a
> platform owner who operates the software across gyms.
>
> Stack: Next.js App Router (`apps/web`), TypeScript, PostgreSQL under a schema named `pilot`,
> deployed to Azure Container Apps. Migrations are explicit SQL files in `infra/azure/` applied
> by a manually dispatched GitHub Actions workflow with a required-reviewer gate on production.
>
> Rules that are load-bearing, not stylistic:
> - The board role is **aggregate-only**. It must never see an individual child. There is a
>   k-anonymity floor of 5 (`BOARD_MINIMUM_COHORT_SIZE`) below which a cohort must not render.
> - The platform owner is **not** a super-admin. Athlete credentials, PIN administration, and
>   session revocation belong to the gym's own organization administrator, not to the platform
>   operator.
> - User-submitted feedback is scanned; anything that could be a child disclosing harm must
>   route to a human, and the submitter must never be told which route their message took.
>
> This is entering a supervised real-world pilot with real children in a real gym. It is not a
> demo and not a public launch.
>
> Most of this code was written by AI agents. Assume competent-looking code that is confidently
> wrong is more likely here than code that is obviously sloppy.

---

## 1. The disclosure adversary — highest stakes, run this one first

**Paste:** `apps/web/src/server/pilot/feedbackSafetyScan.ts` and its test file.

> This module decides whether a message submitted through a feedback box gets treated as a
> product suggestion or escalated to a human being. If it misclassifies a child disclosing
> abuse as a bug report, that disclosure goes into a product backlog and nobody comes.
>
> Do not review this code for quality. Attack it.
>
> Write me 30 messages that **a real child aged 9 to 15 would actually type** which should reach
> a human and which this code routes to product. Give me the exact string, verbatim, as they
> would type it — not a description of a category.
>
> Constraints that make this hard and that I want you to honor:
> - Real spelling. Real phone typing. Autocorrect damage. No capital letters.
> - Children rarely disclose directly. They test the water sideways, minimize, attribute it to a
>   friend, ask a hypothetical, or bury it at the end of an unrelated complaint.
> - The message may be 90% a genuine app complaint with the real thing in the last clause.
> - Some should be about someone at the gym; some about home; some about another kid.
>
> Then, separately: write 10 messages that are **purely ordinary product feedback** which this
> code escalates to a human. Over-escalation is not free — it buries real disclosures in noise
> and it teaches the reviewer to skim.
>
> For each of the 40, state which regex or normalization step you believe decides it, and why
> you think it lands the way it does.

---

## 2. The role boundary prover

**Paste:** `apps/web/src/server/pilot/access.ts`, `boardSummary.ts`, and the output of
`ls apps/web/app/api/pilot/**/route.ts`.

> Below is a role-based access layer and the list of every API route in the application.
>
> For each of these roles — `athlete`, `parent`, `coach`, `organization_admin`, `board`,
> `platform_owner` — find me **one concrete thing that role can reach which the stated design
> says it cannot.** Not a category of risk. A specific route, with the specific request, and the
> specific field that comes back that it should not.
>
> Pay particular attention to:
> - The board being aggregate-only. Can any route, any parameter, any filter combination, or any
>   small-cohort edge case put an individual identifiable child in front of a board member?
>   A cohort of exactly 5 where the viewer already knows 4 of them is a re-identification, and
>   a k-anonymity floor does not stop it.
> - The platform owner not being a super-admin. Where does that boundary leak?
> - Whether a parent can reach a child who is not theirs.
>
> If you cannot find a real one for a given role, say "none found" for that role. Do not invent
> a finding to fill the slot. A fabricated vulnerability costs me more than a missed one,
> because I will spend a day proving it is not real.

---

## 3. What does this actually collect about a child

**Paste:** `infra/azure/pilot_slice_postgres.sql` and any migration files you want traced.

> This is the database schema for a platform used by minors.
>
> Produce a table with one row per column that holds information about a child. For each:
> what it is, where it enters the system, who can read it, how long it is kept, and what
> deletes it.
>
> Then answer three questions plainly:
> 1. What is collected that the platform does not actually use for anything?
> 2. If a parent asked "delete everything you have about my kid," what would survive, and where?
> 3. What is stored here that, if this database leaked tomorrow, would be the worst of it —
>    and is the schema's shape making that worse than it needs to be?
>
> I am not asking for a compliance checklist. I am asking what is true.

---

## 4. The unverified-claim hunter

**Paste:** `docs/PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md` and `docs/WORK_QUEUE_2026-08-01.md`.

> These are audit documents written by AI agents about a codebase they were also writing.
>
> Split every factual claim in them into two lists: claims the document shows evidence for, and
> claims it merely asserts. For the asserted ones, rank them by **what it would cost if the
> claim were false** — a false "this is safe" costs more than a false "this is broken."
>
> Then tell me which three I should verify first, and the exact command or query that would
> settle each one.
>
> Context you should know: this exercise has already found real errors. One of these documents
> asserted four database tables existed in production. They did not exist at all. Nobody had
> looked. Assume more of that is in there.

---

## 5. The gym floor

**Paste:** two or three page components — a coach-facing one, an athlete-facing one.

> Picture the actual conditions. It is 5:45pm on a Tuesday. A volunteer coach has twenty kids
> on the floor, half of them warming up and two of them arguing. The coach's phone has a cracked
> screen, one bar of signal, and it is in a gym bag across the room. Their hands are wrapped or
> gloved. It is loud.
>
> Where does this interface fail that person? Be specific and physical: tap targets they will
> miss, flows that need both hands, states that need a second page load to confirm something
> worked, anything that punishes an interruption by losing entered data, anything that requires
> reading more than a few words.
>
> Then the same for an 11-year-old on a hand-me-down Android, and for a parent who opened this
> once, three weeks ago, and has forgotten everything about it.
>
> Rank by how often it will happen, not by how bad it is when it does.

---

## 6. The AI-written-code adversary

**Paste:** any recently changed module and its tests.

> This code was written by an AI agent that believed it was correct and wrote tests that pass.
>
> Look for the specific pathologies of machine-written code rather than general code smells:
> - Tests that assert what the implementation does rather than what the requirement says. If the
>   implementation is wrong, these tests lock the bug in and turn green while doing it.
> - Comments that state intent the code does not carry out.
> - Defensive handling for states that cannot occur, sitting next to a state that can occur and
>   is unhandled.
> - Abstraction introduced for a second case that never arrived.
> - Error handling that catches, logs, and continues as though nothing happened.
> - Names that describe an intention rather than the behavior — a function called
>   `validateFoo` that returns a value nobody checks.
>
> For each finding, show me the test that would fail if the code were correct, or the input that
> reaches the unhandled state. If you cannot produce either, do not report it.

---

## 7. The deploy chain

**Paste:** `.github/workflows/apply-migrations.yml`, `deploy-staging.yml`, `deploy-production.yml`.

> This is the entire path by which code and schema changes reach a production database serving
> children's records.
>
> Walk it as an adversary and as an unlucky operator:
> - What sequence of dispatches puts application code in production against a schema that does
>   not have what that code expects?
> - What happens if a migration fails halfway? Which of these SQL files are not idempotent, and
>   what does re-running one do?
> - Who can trigger what, and what does the required-reviewer gate actually gate — is any half
>   of this ungated?
> - If a deploy is wrong, what is the rollback, and has it ever been exercised?
>
> Assume the operator is tired and it is late. Which of these steps is easiest to get wrong in a
> way nothing catches?

---

## How to read what comes back

An outside model will produce findings that are wrong. That is expected and it is not a reason
to discount the exercise — the ratio that matters is whether it finds one real thing, not
whether everything it says is real.

Before acting on any finding: **reproduce it against the source.** Every one of the prompts
above asks for a falsifiable artifact — an exact input string, a specific request, a test that
would fail — for exactly this reason. A finding that cannot be reproduced is not a finding,
however well written.

And when it is right and we were wrong, that is the whole point of asking someone who did not
build it.
