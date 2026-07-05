# Handover — Sample (replace me)

> This is a placeholder so the app is testable out of the box. Drop your real
> handover docs (and the stock statement) into this `knowledge/` folder and delete
> this file. Anything here — `.md`, `.txt`, `.pdf` — gets indexed.

## Who to contact while I'm away

- **Deployments / infra:** Priya (Slack `@priya`) — she owns the CDK pipeline.
- **On-call / incidents:** the #ops-oncall Slack channel; escalate to Marcus after 30 min.
- **Billing / vendor questions:** finance@example.com.

## Deploying the service

- Deploys run from the `main` branch via GitHub Actions. A merge to `main` auto-deploys to staging.
- Production deploys are **manual**: run the `Deploy Prod` workflow and get one approval from Priya or Marcus.
- Rollback: re-run the previous successful `Deploy Prod` run, or `git revert` and merge.

## Where credentials live

- All service secrets are in AWS Secrets Manager under the `prod/` prefix. Never in the repo.
- The staging database password is in 1Password, vault "Team — Staging".

## Known issues / gotchas

- The nightly report job occasionally times out if the export is over 2 GB — re-run it manually.
- Do not bump the `image-resizer` Lambda memory below 512 MB; it OOMs on large uploads.

## Recurring tasks

- **Monday:** review the #alerts channel and clear stale PagerDuty incidents.
- **Month-end:** run the reconciliation script and send the summary to finance@example.com.
