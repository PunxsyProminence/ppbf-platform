# Intake

The drop zone for AI-built capabilities. Process manual:
[docs/AI_DELIVERY_PIPELINE.md](../docs/AI_DELIVERY_PIPELINE.md). Rules of
conduct: [docs/AI_CONTRIBUTOR_GUARDRAILS.md](../docs/AI_CONTRIBUTOR_GUARDRAILS.md).

```
intake/
  tickets/        one file per unit of work, T-<nnn>-<slug>.md
                  → copy a ticket into any AI as its complete prompt
  tickets/done/   shipped tickets, each closed with PR #, SHA, digest, evidence
  drops/          gitignored — where chat-only AI output lands, one folder
                  per ticket, mirroring repo paths. The gatekeeper is the
                  only way out of this folder and into a commit.
```

## For the owner

1. Pick an open ticket from `tickets/`.
2. Hand it to an AI — paste the whole file; it is written to be
   self-sufficient.
3. Git-capable AI: it opens a draft PR itself. Chat-only AI: save its output
   under `drops/<ticket-id>/` and tell the gatekeeper the drop is in.
4. Approve the production gate when GitHub asks. That is the whole job.

## For builder AIs reading this

Your ticket is your entire scope. The pipeline doc's lane instructions bind
you. Two things that surprise newcomers:

- **You cannot push twice.** A repository ruleset rejects updates to a
  pushed branch. Get the branch right, push once, open the PR as draft.
  Revisions mean a new branch (`-v2`) and a new PR.
- **Claims need evidence.** Cite the command you ran and its output, or
  label the claim `UNVERIFIED`. PRs asserting "works" with an empty
  Evidence section are returned unread.
